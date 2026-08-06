using Papyra.Api.Storage;

namespace Papyra.Tests;

public sealed class RagChatServiceTests
{
    [Fact]
    public void SystemPrompt_GroundsTheModelInTheRetrievedNotes()
    {
        var prompt = RagChatService.BuildSystemPrompt(
        [
            new Citation("n1", "Advertising Budget", "We allocated 45000 pounds.", 0.76),
            new Citation("n2", "Lisbon Trip", "Flights booked for June.", 0.46),
        ]);

        // Both retrieved chunks and their titles must reach the model.
        Assert.Contains("Advertising Budget", prompt);
        Assert.Contains("We allocated 45000 pounds.", prompt);
        Assert.Contains("Lisbon Trip", prompt);
        // And it must be told not to answer from anything else.
        Assert.Contains("ONLY the notes below", prompt);
        Assert.Contains("Never invent details.", prompt);
    }

    [Fact]
    public void SystemPrompt_WithNoMatches_StillForbidsInvention()
    {
        var prompt = RagChatService.BuildSystemPrompt([]);
        Assert.Contains("(no relevant notes found)", prompt);
        Assert.Contains("could not find it in their notes", prompt);
    }
}
