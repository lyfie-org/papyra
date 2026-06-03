using Papyra.Api.Models;

namespace Papyra.Api.Services;

public interface IMarkdownStorageService
{
    string       SerializeNote(Note note);
    Note         DeserializeNote(string fileContent);
    NoteMetadata ParseFrontmatterOnly(Stream stream);
}
