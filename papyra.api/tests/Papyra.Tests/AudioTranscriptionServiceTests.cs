using Papyra.Api.Models;
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

    [Fact]
    public void ADay_OfTheJournal_IsNeverWrittenToBehindTheWritersBack()
    {
        Assert.True(AudioTranscriptionService.TakesTranscript(new Note { Id = "n1", Title = "Meeting", Kind = "note" }));
        Assert.False(AudioTranscriptionService.TakesTranscript(new Note { Id = "journal-2026-10-24", Title = "2026-10-24", Kind = "journal" }));
        Assert.False(AudioTranscriptionService.TakesTranscript(new Note { Id = "n2", Title = "Locked", Secure = true }));
        Assert.False(AudioTranscriptionService.TakesTranscript(new Note { Id = "n3", Title = "Gone", Trashed = true }));
    }
}
