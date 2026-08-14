import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, ListChecks } from 'lucide-react';
import { useNotes } from '../hooks/useNotes';
import TodoCard from '../components/TodoCard';
import EmptyState from '../components/EmptyState';
import { putNote } from '../lib/notesApi';
import './TodoPage.css';

export default function TodoPage() {
  const { data: notes, isLoading, isError } = useNotes();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const todos = (notes ?? []).filter(n => n.kind === 'todo' && !n.trashed && !n.archived);

  // Create = PUT a fresh todo note seeded with one empty checkbox, then open it.
  async function createTodo() {
    const id = crypto.randomUUID();
    await putNote(id, {
      title: '', tags: [], color: null, pinned: false, archived: false,
      kind: 'todo', body: '- [ ] ',
    });
    await queryClient.invalidateQueries({ queryKey: ['notes'] });
    navigate(`/note/${id}`);
  }

  return (
    <section className="todo-page">
      <header className="todo-page__head">
        <h1 className="page-title todo-page__title">To Do</h1>
        <button type="button" className="todo-page__new" onClick={() => void createTodo()}>
          <Plus size={18} /> New list
        </button>
      </header>

      {isLoading && <p className="todo-page__status">Loading…</p>}
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

      <div className="todo-grid">
        {todos.map(n => <TodoCard key={n.id} note={n} />)}
      </div>
    </section>
  );
}
