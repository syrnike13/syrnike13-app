# Keep the native media utility alive across Room sessions

The Windows media utility and LiveKit global runtime are app/session scoped, while Room attempts, desired state, and credential leases are connection-epoch scoped. Reusing one isolated process avoids repeated SDK initialization and supports a future warm microphone. Credentials enter a private store with a capacity of four, are consumed before one connection attempt, and are cleared on shutdown, so desired state and snapshots never become replayable bearer-token storage.
