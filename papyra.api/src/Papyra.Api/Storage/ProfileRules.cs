using System.Net.Mail;
using System.Text.RegularExpressions;

namespace Papyra.Api.Storage;

/// <summary>
/// What a person may set on their own profile.
///
/// The username rule is the mention rule (<c>MentionDeliveryService</c>): a name
/// that could not be typed as <c>@name</c> would make its owner impossible to
/// mention or share with. It must also end on a letter or digit — the mention
/// pattern stops at a word boundary, so <c>@bea.</c> would resolve to "bea".
/// </summary>
public static partial class ProfileRules
{
    public const int MinUsernameLength = 2;
    public const int MaxUsernameLength = 64;
    public const int MaxNameLength = 100;

    [GeneratedRegex(@"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")]
    private static partial Regex UsernameShape();

    /// <summary>A reason the username can't be used, or null when it can.</summary>
    public static string? UsernameProblem(string username)
    {
        if (username.Length < MinUsernameLength || username.Length > MaxUsernameLength)
            return $"Usernames are {MinUsernameLength}–{MaxUsernameLength} characters.";
        if (!UsernameShape().IsMatch(username))
            return "Use letters, numbers, dots, dashes or underscores, starting and ending with a letter or number.";
        return null;
    }

    /// <summary>A single, plain address — no display name, no list.</summary>
    public static bool IsEmail(string value)
    {
        if (value.Length > 254 || value.Contains(' ') || value.Contains(',')) return false;
        try
        {
            var parsed = new MailAddress(value);
            return parsed.Address == value && value.IndexOf('@') > 0 && value.LastIndexOf('.') > value.IndexOf('@');
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
