namespace Papyra.Tests;

// Tests that assert on wall-clock behaviour (debounce windows, watcher latency)
// can't share the machine with the rest of the suite: an unrelated test that
// saturates the CPU or blocks thread-pool threads delays their timers and they
// fail for reasons that have nothing to do with the code under test.
//
// xUnit runs collections in parallel by default; opting this one out means its
// tests run on their own, so a timing assertion measures the observer rather
// than the state of the runner.
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TimingSensitiveCollection
{
    public const string Name = "timing-sensitive";
}
