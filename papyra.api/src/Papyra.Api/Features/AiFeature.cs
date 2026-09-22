namespace Papyra.Api.Features;

/// <summary>
/// The switch that holds the assistant back for a later release.
///
/// Everything the assistant needs is still here — the providers, the vector
/// cache, the conversation store — but none of it is reachable while the switch
/// is off: the routes answer 404 and stay out of the OpenAPI document, the
/// background embedder never starts, and the web UI hides the matching surfaces
/// (see <c>papyra.web/src/lib/features.ts</c>).
///
/// 404 rather than 403 on purpose. "Switched off for now" is not "you may not",
/// and an endpoint that does not exist yet is the honest answer for a client
/// that finds the route in an older copy of the docs.
///
/// Turn it back on with <c>Features:Ai=true</c> (or <c>PAPYRA_AI_ENABLED=true</c>),
/// and flip <c>AI_ENABLED</c> in the web app to match.
/// </summary>
public static class AiFeature
{
    public const string ConfigKey = "Features:Ai";

    /// <summary>Whether this instance serves the assistant. Off unless asked for.</summary>
    public static bool Enabled(IConfiguration config) => config.GetValue(ConfigKey, false);

    private const string OffMessage =
        "The assistant is not enabled on this instance.";

    /// <summary>
    /// Leaves the route mapped but unreachable while the feature is off, so the
    /// handler below keeps compiling against the services it needs and comes back
    /// by flipping one setting.
    /// </summary>
    public static TBuilder RequireAiFeature<TBuilder>(this TBuilder builder, bool enabled)
        where TBuilder : IEndpointConventionBuilder
    {
        if (enabled) return builder;

        builder.AddEndpointFilter((_, _) =>
            ValueTask.FromResult<object?>(Results.NotFound(new { error = OffMessage })));
        // A documented endpoint that always 404s is worse than an undocumented
        // one: it reads as a broken API rather than a feature that hasn't shipped.
        builder.ExcludeFromDescription();
        return builder;
    }
}
