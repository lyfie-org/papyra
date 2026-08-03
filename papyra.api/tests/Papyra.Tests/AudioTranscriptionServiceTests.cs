using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class AudioTranscriptionServiceTests
{
    [Fact]
    public void Append_AddsBlockquote_AfterExistingBody()
    {
        var result = AudioTranscriptionService.AppendTranscription("Meeting notes.", "Hello world.");
        Assert.Equal("Meeting notes.\n\n> [Transcription]: Hello world.\n", result);
    }

    [Fact]
    public void Append_ToEmptyBody_HasNoLeadingBlankLines()
    {
        Assert.Equal("> [Transcription]: Hi.\n", AudioTranscriptionService.AppendTranscription("", "Hi."));
    }

    [Fact]
    public void Append_TrimsTrailingWhitespace_AndNormalisesSpacing()
    {
        var result = AudioTranscriptionService.AppendTranscription("Body.\n\n\n", "  spaced  ");
        Assert.Equal("Body.\n\n> [Transcription]: spaced\n", result);
    }
}
