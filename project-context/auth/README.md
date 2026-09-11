# Auth Route

## TL;DR
- Auth owns manager account creation, login, and session handling for August.
- A manager is the only user role for the MVP — no admin or team-member roles yet.
- Session state must be verified server-side on every API request, never trusted from the client alone.
- Key files: not yet created — planned under a backend auth module per project-context/roadmap/README.md.

This route governs how managers create accounts, log in, and stay authenticated across August.

## Purpose

Every other route (meetings, media processing) is scoped to a logged-in manager. Auth owns the rules for who a manager is, how they log in, and how their identity is attached to their meetings, videos, and photos.

## Core Concepts

- Manager account: the sole user entity for the MVP — email, password (hashed), and profile basics.
- Session: a server-verified authenticated state tied to a manager, used to scope all other routes' data access.
- Login / logout: the manager-facing entry and exit points for a session.

## Invariants

- A manager can only ever access their own meetings, videos, and photos — never another manager's data.
- Passwords are never stored or logged in plaintext.
- Every API request outside of login/signup must be authenticated server-side before touching manager data.

## Route-Specific Constraints

- [REQUIRES PRODUCT FILLING: no data in the code] — whether signup is open or invite-only for the MVP.
- [REQUIRES PRODUCT FILLING: no data in the code] — session mechanism (e.g. JWT vs. server session store) once implementation starts.
- No third-party AI APIs are involved in this route; it is standard application logic only.
