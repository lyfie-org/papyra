using Papyra.Api.Security;

namespace Papyra.Tests;

/// <summary>
/// The plain-English environment variable names.
///
/// Every failure mode here is silent — a misspelled or wrongly-shaped setting is
/// not an error, it is simply ignored, and the operator finds out weeks later
/// when something does not behave. So the mapping is pinned rather than trusted.
/// </summary>
public sealed class EnvAliasesTests
{
    private static Dictionary<string, string?> Env(params (string Key, string? Value)[] pairs)
    {
        var map = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in pairs) map[k] = v;
        return map;
    }

    [Fact]
    public void AnEmptyEnvironmentAsksForNothing()
        => Assert.Empty(EnvAliases.Resolve(Env()));

    [Theory]
    [InlineData("PAPYRA_DATA_DIR", "/data", "Papyra:DataDir")]
    [InlineData("PAPYRA_ALLOW_INSECURE_COOKIES", "true", "Papyra:AllowInsecureCookies")]
    [InlineData("PAPYRA_OLLAMA_URL", "http://ollama:11434", "Ollama:BaseUrl")]
    [InlineData("PAPYRA_WEBAUTHN_DOMAIN", "papyra.example.com", "WebAuthn:ServerDomain")]
    [InlineData("PAPYRA_WHISPER_MODEL_PATH", "/models/ggml-base.bin", "Whisper:ModelPath")]
    [InlineData("PAPYRA_OCR_TESSDATA_PATH", "/tessdata", "Ocr:TessDataPath")]
    public void EachFriendlyNameFeedsItsConfigurationKey(string env, string value, string key)
    {
        var resolved = EnvAliases.Resolve(Env((env, value)));
        Assert.Equal(value, resolved[key]);
    }

    [Fact]
    public void AListIsWrittenCommaSeparatedAndBoundAsAnArray()
    {
        // The shape .NET binds a string[] from. Writing the comma-joined string
        // into `Cors__AllowedOrigins__0` by hand instead produces ONE entry equal
        // to the whole literal, which matches no origin — silently.
        var resolved = EnvAliases.Resolve(
            Env(("PAPYRA_ALLOWED_ORIGINS", "http://a.example,http://b.example")));

        Assert.Equal("http://a.example", resolved["Cors:AllowedOrigins:0"]);
        Assert.Equal("http://b.example", resolved["Cors:AllowedOrigins:1"]);
    }

    [Fact]
    public void ListEntriesAreTrimmed_BecausePeopleWriteCommaSpace()
    {
        var resolved = EnvAliases.Resolve(
            Env(("PAPYRA_TRUSTED_PROXIES", "10.0.0.1, 10.0.0.2 ,10.0.0.3")));

        Assert.Equal("10.0.0.1", resolved["Papyra:TrustedProxies:0"]);
        Assert.Equal("10.0.0.2", resolved["Papyra:TrustedProxies:1"]);
        Assert.Equal("10.0.0.3", resolved["Papyra:TrustedProxies:2"]);
    }

    [Fact]
    public void ASingleItemListStillBindsAsAList()
    {
        var resolved = EnvAliases.Resolve(Env(("PAPYRA_ALLOWED_ORIGINS", "http://only.example")));
        Assert.Equal("http://only.example", Assert.Single(resolved).Value);
    }

    [Fact]
    public void EmptyEntriesAreDroppedRatherThanBoundAsBlanks()
    {
        // "a,,b" and a trailing comma are both typos, not a request for an empty
        // origin — which would be an origin that can never match.
        var resolved = EnvAliases.Resolve(Env(("PAPYRA_ALLOWED_ORIGINS", "http://a.example,,http://b.example,")));

        Assert.Equal(2, resolved.Count);
        Assert.Equal("http://b.example", resolved["Cors:AllowedOrigins:1"]);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ABlankValueSelectsNothing(string blank)
    {
        // Unset and set-to-empty must read the same: neither is a choice, and a
        // blank must never overwrite a value from appsettings.
        Assert.Empty(EnvAliases.Resolve(Env(("PAPYRA_DATA_DIR", blank))));
    }

    [Fact]
    public void ANullValueSelectsNothing()
        => Assert.Empty(EnvAliases.Resolve(Env(("PAPYRA_DATA_DIR", null))));

    [Fact]
    public void AScalarIsTrimmed()
    {
        var resolved = EnvAliases.Resolve(Env(("PAPYRA_OLLAMA_URL", "  http://ollama:11434  ")));
        Assert.Equal("http://ollama:11434", resolved["Ollama:BaseUrl"]);
    }

    [Fact]
    public void AnUnrecognisedVariableIsIgnored_NotGuessedAt()
    {
        Assert.Empty(EnvAliases.Resolve(Env(("PAPYRA_SOMETHING_INVENTED", "x"))));
    }

    [Fact]
    public void SeveralSettingsAtOnceAllArrive()
    {
        var resolved = EnvAliases.Resolve(Env(
            ("PAPYRA_ALLOW_INSECURE_COOKIES", "true"),
            ("PAPYRA_OLLAMA_URL", "http://ollama:11434"),
            ("PAPYRA_ALLOWED_ORIGINS", "http://a.example,http://b.example")));

        Assert.Equal("true", resolved["Papyra:AllowInsecureCookies"]);
        Assert.Equal("http://ollama:11434", resolved["Ollama:BaseUrl"]);
        Assert.Equal("http://a.example", resolved["Cors:AllowedOrigins:0"]);
        Assert.Equal("http://b.example", resolved["Cors:AllowedOrigins:1"]);
    }
}
