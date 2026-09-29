using System.Security.Cryptography;

namespace Papyra.Api.Collab;

/// <summary>
/// Live collaboration settings. Self-hosters never touch these: the engine is
/// bundled in the image and started by <see cref="CollabHost"/>. The only knob
/// is the opt-out, <c>PAPYRA_COLLAB_ENABLED=false</c> (<c>Features:Collab</c>).
/// </summary>
public sealed class CollabOptions
{
    public const string FeatureKey = "Features:Collab";

    /// <summary>Master switch (default on). Off → every note uses the classic autosave editor.</summary>
    public bool Enabled { get; init; } = true;

    /// <summary>
    /// Use an engine someone else started (dev: <c>pnpm dev</c> runs it with
    /// <c>tsx watch</c>) instead of spawning one. Loopback URL, e.g. http://127.0.0.1:5231.
    /// </summary>
    public string? Url { get; init; }

    /// <summary>Node executable used to run the bundled engine.</summary>
    public string NodePath { get; init; } = "node";

    /// <summary>Bundled engine script. Relative paths resolve against the content root.</summary>
    public string Script { get; init; } = Path.Combine("collab", "server.mjs");

    /// <summary>
    /// Secret shared with the engine for tickets and internal calls. Generated
    /// fresh each boot when unset (the normal case); only a dev engine started
    /// by hand needs a fixed one.
    /// </summary>
    public string Secret { get; init; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    /// <summary>How long a room ticket stays valid for connecting.</summary>
    public TimeSpan TicketLifetime { get; init; } = TimeSpan.FromSeconds(60);

    public static CollabOptions From(IConfiguration config)
    {
        var section = config.GetSection("Collab");
        var secret = section["Secret"];
        return new CollabOptions
        {
            Enabled = config.GetValue(FeatureKey, true),
            Url = string.IsNullOrWhiteSpace(section["Url"]) ? null : section["Url"],
            NodePath = section["NodePath"] ?? "node",
            Script = section["Script"] ?? Path.Combine("collab", "server.mjs"),
            Secret = string.IsNullOrWhiteSpace(secret)
                ? Convert.ToHexString(RandomNumberGenerator.GetBytes(32))
                : secret,
        };
    }
}
