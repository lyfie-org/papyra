namespace Papyra.Api.Storage;

/// <summary>
/// The rules a save of a locked (<c>secure</c>) note must obey, shared by every
/// route that writes note bodies — the generic <c>PUT /api/notes/{id}</c> and the
/// journal's <c>PUT /api/journal/{date}</c> — so they can't drift apart.
/// <list type="bullet">
///   <item>A locked body never rides a list, so a save built from the list carries
///   an empty body it never saw; only that exact shape keeps the stored body. The
///   open editor's autosave carries no unlock token either, so any non-empty
///   body lands as written.</item>
///   <item>Locking needs a vault PIN; taking the lock off needs the vault open now.</item>
/// </list>
/// </summary>
public static class NoteWriteGuards
{
    /// <summary>True when the stored body must be kept instead of the (empty) incoming one.</summary>
    public static bool KeepsLockedBody(bool wasSecure, bool wantsSecure, string? incomingBody, bool unlockedNow, bool hasPrior) =>
        wasSecure && wantsSecure && string.IsNullOrEmpty(incomingBody) && !unlockedNow && hasPrior;

    public enum LockChange { None, NeedsPin, NeedsUnlock }

    public static LockChange CheckLockChange(bool wasSecure, bool wantsSecure, bool pinSet, bool unlockedNow)
    {
        if (wantsSecure && !wasSecure && !pinSet) return LockChange.NeedsPin;
        if (wasSecure && !wantsSecure && !unlockedNow) return LockChange.NeedsUnlock;
        return LockChange.None;
    }
}
