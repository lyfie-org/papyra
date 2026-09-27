import { useNavigate } from 'react-router-dom';
import { Plus, ListChecks } from 'lucide-react';
import { useNotes } from '../hooks/useNotes';
import DraggableNoteGrid from '../components/DraggableNoteGrid';
import EmptyState from '../components/EmptyState';
import { createDraft } from '../lib/noteDrafts';
import './TodoPage.css';
import LoadingBar from '../components/LoadingBar';

export default function TodoPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const navigate = useNavigate();

  const todos = (notes ?? []).filter(n => n.kind === 'todo' && !n.trashed && !n.archived);

  // Open a draft list seeded with one empty checkbox; like a new note, it is
  // saved on the first change and dropped if closed untouched.
  function createTodo() {
    navigate(`/note/${createDraft('todo', '- [ ] ')}`);
  }

  return (
    <section className="todo-page">
      <header className="todo-page__head">
        <h1 className="page-title todo-page__title">To Do</h1>
        <button type="button" className="todo-page__new" onClick={createTodo}>
          <Plus size={18} /> New list
        </button>
      </header>

      {isLoading && <LoadingBar label="Loading to-dos" />}
      {isError && <p className="todo-page__status">Couldn’t reach the server.</p>}
      {!isLoading && !isError && todos.length === 0 && (
        <EmptyState
          icon={ListChecks}
          title="No to-do lists yet"
          body="A to-do list is an ordinary note with tickable items, so it is saved, searched and backed up exactly like everything else you write."
          hint="Start one below, or open any note and mark it as a to-do from its toolbar."
          action={{ label: 'New list', onClick: () => void createTodo() }}
        />
      )}

      {/* Same desk as Notes: drag to arrange, tick to select many, pin to the top. */}
      {todos.length > 0 && (
        <div className="todo-grid">
          <DraggableNoteGrid notes={notes ?? []} todosOnly />
        </div>
      )}
    </section>
  );
}
