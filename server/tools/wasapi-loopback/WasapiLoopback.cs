// WasapiLoopback.cs — AUG-112. Single-file WASAPI loopback capture helper for August.
//
// Compiled on demand by the server (server/src/services/wasapiHelper.ts) with the
// .NET Framework 4.x csc.exe that ships with Windows 10/11 — no NuGet, no NAudio.
// Raw COM interop only (IMMDeviceEnumerator, IAudioClient, IAudioCaptureClient).
//
//   wasapi-loopback.exe --probe
//       prints ONE JSON line to stdout describing the default render endpoint's mix
//       format, e.g. {"sampleRate":48000,"channels":2,"format":"f32le","bitsPerSample":32,"device":"Headphones"}
//       and exits 0. Exit 2 = no default output device. Exit 1 = other failure (stderr).
//
//   wasapi-loopback.exe
//       captures the default render endpoint in loopback mode and writes raw interleaved
//       PCM in the mix format to stdout until stdin closes (EOF) or the process is killed.
//       Diagnostics go to stderr only. stdout carries nothing but PCM.
//
// Silence-fill invariant: WASAPI loopback delivers no packets while nothing is playing.
// The helper tracks wall-clock frames since start and writes zero frames for any gap
// (AUDCLNT_BUFFERFLAGS_SILENT packets and missing packets), so stdout is a continuous
// real-time stream and the resulting WAV length matches the capture length.
//
// NOTE: the process exits when stdin reaches EOF. Spawn it with stdin as an open pipe
// (Node: stdio[0] = 'pipe'); stdin 'ignore' (NUL) would end it immediately.

using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace August.WasapiLoopback
{
    internal static class Native
    {
        public const int EDataFlow_eRender = 0;
        public const int ERole_eConsole = 0;
        public const int CLSCTX_ALL = 23;
        public const int STGM_READ = 0;
        public const int AUDCLNT_SHAREMODE_SHARED = 0;
        public const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        public const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        public const int AUDCLNT_S_BUFFER_EMPTY = 0x08890001;
        public const int E_NOTFOUND = unchecked((int)0x80070490);
        public const ushort WAVE_FORMAT_PCM = 1;
        public const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        public const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
        public const ushort VT_LPWSTR = 31;
        public const int PKEY_Device_FriendlyName_pid = 14;

        public static readonly Guid KSDATAFORMAT_SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");
        public static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");
        public static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        public static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        public static readonly Guid PKEY_Device_FriendlyName_fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PROPVARIANT pvar);

        [DllImport("ole32.dll")]
        public static extern void CoTaskMemFree(IntPtr ptr);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY
    {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPVARIANT
    {
        public ushort vt;
        public ushort r1;
        public ushort r2;
        public ushort r3;
        public IntPtr p;
        public IntPtr p2;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    internal struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrameCount);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    internal sealed class MixFormat
    {
        public IntPtr Ptr;
        public int SampleRate;
        public int Channels;
        public int BlockAlign;
        public int BitsPerSample;
        public string FfmpegName;
    }

    internal sealed class NoDefaultDeviceException : Exception
    {
        public NoDefaultDeviceException() : base("No default output device") { }
    }

    internal sealed class StopSignal
    {
        public volatile bool Requested;
    }

    internal static class Program
    {
        // 200 ms WASAPI buffer: headroom against polling jitter (100-ns units).
        private const long BUFFER_DURATION_100NS = 2000000;
        private const int POLL_SLEEP_MS = 10;
        // No packet for this long → treat as silence and start zero-filling.
        private const int SILENCE_GAP_MS = 200;
        // While filling after real audio has been seen, stay this far behind wall-clock so
        // resumed packets do not overlap the zeros.
        private const int FILL_LAG_MS = 30;

        private const int EXIT_OK = 0;
        private const int EXIT_FAILURE = 1;
        private const int EXIT_NO_DEVICE = 2;
        private const int EXIT_USAGE = 64;

        private static int Main(string[] args)
        {
            bool probe = args.Length == 1 && args[0] == "--probe";
            if (args.Length > 0 && !probe)
            {
                Console.Error.WriteLine("usage: wasapi-loopback.exe [--probe]");
                return EXIT_USAGE;
            }
            try
            {
                return probe ? RunProbe() : RunCapture();
            }
            catch (NoDefaultDeviceException ex)
            {
                Console.Error.WriteLine("wasapi-loopback: " + ex.Message);
                return EXIT_NO_DEVICE;
            }
            catch (COMException ex)
            {
                Console.Error.WriteLine("wasapi-loopback: " + ex.Message + " (HRESULT 0x" + ex.ErrorCode.ToString("X8", CultureInfo.InvariantCulture) + ")");
                return EXIT_FAILURE;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("wasapi-loopback: " + ex.GetType().Name + ": " + ex.Message);
                return EXIT_FAILURE;
            }
        }

        private static void Check(int hr, string what)
        {
            if (hr < 0) throw new COMException(what + " failed", hr);
        }

        private static void OpenDefaultRender(out IMMDevice device, out IAudioClient client, out MixFormat format)
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            int hr = enumerator.GetDefaultAudioEndpoint(Native.EDataFlow_eRender, Native.ERole_eConsole, out device);
            if (hr == Native.E_NOTFOUND || (hr >= 0 && device == null)) throw new NoDefaultDeviceException();
            Check(hr, "IMMDeviceEnumerator.GetDefaultAudioEndpoint");
            object activated;
            Guid iid = Native.IID_IAudioClient;
            Check(device.Activate(ref iid, Native.CLSCTX_ALL, IntPtr.Zero, out activated), "IMMDevice.Activate(IAudioClient)");
            client = (IAudioClient)activated;
            format = ReadMixFormat(client);
        }

        private static MixFormat ReadMixFormat(IAudioClient client)
        {
            IntPtr ptr;
            Check(client.GetMixFormat(out ptr), "IAudioClient.GetMixFormat");
            WAVEFORMATEX wf = (WAVEFORMATEX)Marshal.PtrToStructure(ptr, typeof(WAVEFORMATEX));
            bool isFloat;
            if (wf.wFormatTag == Native.WAVE_FORMAT_EXTENSIBLE)
            {
                // WAVEFORMATEXTENSIBLE: WAVEFORMATEX (18) + wValidBitsPerSample (2) + dwChannelMask (4) + SubFormat GUID (16)
                byte[] guidBytes = new byte[16];
                Marshal.Copy(new IntPtr(ptr.ToInt64() + 24), guidBytes, 0, 16);
                Guid sub = new Guid(guidBytes);
                if (sub == Native.KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) isFloat = true;
                else if (sub == Native.KSDATAFORMAT_SUBTYPE_PCM) isFloat = false;
                else throw new InvalidOperationException("Unsupported mix format subtype " + sub.ToString());
            }
            else if (wf.wFormatTag == Native.WAVE_FORMAT_IEEE_FLOAT) isFloat = true;
            else if (wf.wFormatTag == Native.WAVE_FORMAT_PCM) isFloat = false;
            else throw new InvalidOperationException("Unsupported mix format tag " + wf.wFormatTag.ToString(CultureInfo.InvariantCulture));

            string name;
            if (isFloat)
            {
                if (wf.wBitsPerSample == 32) name = "f32le";
                else if (wf.wBitsPerSample == 64) name = "f64le";
                else throw new InvalidOperationException("Unsupported float sample size " + wf.wBitsPerSample.ToString(CultureInfo.InvariantCulture));
            }
            else
            {
                switch (wf.wBitsPerSample)
                {
                    case 8: name = "u8"; break;
                    case 16: name = "s16le"; break;
                    case 24: name = "s24le"; break;
                    case 32: name = "s32le"; break;
                    default: throw new InvalidOperationException("Unsupported PCM sample size " + wf.wBitsPerSample.ToString(CultureInfo.InvariantCulture));
                }
            }
            MixFormat result = new MixFormat();
            result.Ptr = ptr;
            result.SampleRate = (int)wf.nSamplesPerSec;
            result.Channels = wf.nChannels;
            result.BlockAlign = wf.nBlockAlign;
            result.BitsPerSample = wf.wBitsPerSample;
            result.FfmpegName = name;
            return result;
        }

        private static string FriendlyName(IMMDevice device)
        {
            const string fallback = "Default output device";
            IPropertyStore store;
            if (device.OpenPropertyStore(Native.STGM_READ, out store) < 0 || store == null) return fallback;
            PROPERTYKEY key = new PROPERTYKEY();
            key.fmtid = Native.PKEY_Device_FriendlyName_fmtid;
            key.pid = Native.PKEY_Device_FriendlyName_pid;
            PROPVARIANT value;
            if (store.GetValue(ref key, out value) < 0) return fallback;
            try
            {
                if (value.vt == Native.VT_LPWSTR && value.p != IntPtr.Zero)
                {
                    string name = Marshal.PtrToStringUni(value.p);
                    return string.IsNullOrEmpty(name) ? fallback : name;
                }
                return fallback;
            }
            finally
            {
                Native.PropVariantClear(ref value);
            }
        }

        // ASCII-only JSON string: non-ASCII goes out as \uXXXX so console code pages cannot garble it.
        private static string JsonString(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7E) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static int RunProbe()
        {
            IMMDevice device;
            IAudioClient client;
            MixFormat format;
            OpenDefaultRender(out device, out client, out format);
            try
            {
                string json = "{\"sampleRate\":" + format.SampleRate.ToString(CultureInfo.InvariantCulture)
                    + ",\"channels\":" + format.Channels.ToString(CultureInfo.InvariantCulture)
                    + ",\"format\":" + JsonString(format.FfmpegName)
                    + ",\"bitsPerSample\":" + format.BitsPerSample.ToString(CultureInfo.InvariantCulture)
                    + ",\"device\":" + JsonString(FriendlyName(device))
                    + "}\n";
                byte[] bytes = Encoding.ASCII.GetBytes(json);
                Stream stdout = Console.OpenStandardOutput();
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
                return EXIT_OK;
            }
            finally
            {
                Native.CoTaskMemFree(format.Ptr);
            }
        }

        private static void WatchStdin(object state)
        {
            StopSignal signal = (StopSignal)state;
            try
            {
                Stream stdin = Console.OpenStandardInput();
                byte[] buffer = new byte[64];
                while (stdin.Read(buffer, 0, buffer.Length) > 0)
                {
                }
            }
            catch (Exception)
            {
            }
            signal.Requested = true;
        }

        private static void WriteZeros(Stream stdout, byte[] zeros, long bytes)
        {
            while (bytes > 0)
            {
                int chunk = bytes > zeros.Length ? zeros.Length : (int)bytes;
                stdout.Write(zeros, 0, chunk);
                bytes -= chunk;
            }
        }

        private static int RunCapture()
        {
            IMMDevice device;
            IAudioClient client;
            MixFormat format;
            OpenDefaultRender(out device, out client, out format);
            string name = FriendlyName(device);
            try
            {
                Check(client.Initialize(Native.AUDCLNT_SHAREMODE_SHARED, Native.AUDCLNT_STREAMFLAGS_LOOPBACK, BUFFER_DURATION_100NS, 0, format.Ptr, IntPtr.Zero), "IAudioClient.Initialize(loopback)");
            }
            finally
            {
                Native.CoTaskMemFree(format.Ptr);
                format.Ptr = IntPtr.Zero;
            }
            object service;
            Guid iid = Native.IID_IAudioCaptureClient;
            Check(client.GetService(ref iid, out service), "IAudioClient.GetService(IAudioCaptureClient)");
            IAudioCaptureClient capture = (IAudioCaptureClient)service;

            Console.Error.WriteLine("wasapi-loopback: capturing \"" + name + "\" " + format.SampleRate.ToString(CultureInfo.InvariantCulture)
                + " Hz, " + format.Channels.ToString(CultureInfo.InvariantCulture) + " ch, " + format.FfmpegName);

            StopSignal stop = new StopSignal();
            Thread watcher = new Thread(new ParameterizedThreadStart(WatchStdin));
            watcher.IsBackground = true;
            watcher.Start(stop);

            Stream stdout = Console.OpenStandardOutput();
            byte[] zeros = new byte[format.BlockAlign * format.SampleRate / 10]; // 100 ms of silence
            byte[] scratch = new byte[format.BlockAlign * format.SampleRate];    // 1 s scratch buffer

            Check(client.Start(), "IAudioClient.Start");
            Stopwatch clock = Stopwatch.StartNew();
            long framesWritten = 0;
            long lastPacketMs = -1;
            bool sawPacket = false;
            long framesFilled = 0;

            try
            {
                while (!stop.Requested)
                {
                    // Drain every packet the device has ready.
                    while (!stop.Requested)
                    {
                        uint next;
                        Check(capture.GetNextPacketSize(out next), "IAudioCaptureClient.GetNextPacketSize");
                        if (next == 0) break;
                        IntPtr data;
                        uint frames;
                        uint flags;
                        ulong devicePosition;
                        ulong qpcPosition;
                        int hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                        if (hr == Native.AUDCLNT_S_BUFFER_EMPTY) break;
                        Check(hr, "IAudioCaptureClient.GetBuffer");
                        int bytes = (int)frames * format.BlockAlign;
                        if ((flags & Native.AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                        {
                            WriteZeros(stdout, zeros, bytes);
                        }
                        else if (bytes > 0)
                        {
                            if (scratch.Length < bytes) scratch = new byte[bytes];
                            Marshal.Copy(data, scratch, 0, bytes);
                            stdout.Write(scratch, 0, bytes);
                        }
                        Check(capture.ReleaseBuffer(frames), "IAudioCaptureClient.ReleaseBuffer");
                        framesWritten += frames;
                        lastPacketMs = clock.ElapsedMilliseconds;
                        sawPacket = true;
                    }

                    // Silence fill: keep stdout at wall-clock rate when the device is quiet.
                    long elapsedMs = clock.ElapsedMilliseconds;
                    bool idle = !sawPacket || (elapsedMs - lastPacketMs) >= SILENCE_GAP_MS;
                    if (idle)
                    {
                        long targetMs = sawPacket ? elapsedMs - FILL_LAG_MS : elapsedMs;
                        long targetFrames = targetMs * format.SampleRate / 1000;
                        long missing = targetFrames - framesWritten;
                        if (missing > 0)
                        {
                            WriteZeros(stdout, zeros, missing * format.BlockAlign);
                            framesWritten += missing;
                            framesFilled += missing;
                        }
                    }
                    stdout.Flush();
                    Thread.Sleep(POLL_SLEEP_MS);
                }
            }
            catch (IOException ex)
            {
                // Downstream (ffmpeg) closed the pipe — that is a normal end of capture.
                Console.Error.WriteLine("wasapi-loopback: stdout closed (" + ex.Message + ")");
            }
            finally
            {
                client.Stop();
            }
            try { stdout.Flush(); } catch (Exception) { }
            Console.Error.WriteLine("wasapi-loopback: stopped after " + framesWritten.ToString(CultureInfo.InvariantCulture)
                + " frames (" + framesFilled.ToString(CultureInfo.InvariantCulture) + " zero-filled, "
                + clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture) + " ms)");
            return EXIT_OK;
        }
    }
}
