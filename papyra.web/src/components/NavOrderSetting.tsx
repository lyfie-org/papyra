import { ArrowDown, ArrowUp, BookOpen, ListTodo, StickyNote } from 'lucide-react';
import { moved, setNavOrder, useNavOrder, WRITING_PLACES, type WritingPlace } from '../lib/navOrder';
import './NavOrderSetting.css';

const PLACES: Record<WritingPlace, { label: string; icon: typeof StickyNote }> = {
  notes: { label: 'Notes', icon: StickyNote },
  todo: { label: 'To Do', icon: ListTodo },
  journal: { label: 'Journal', icon: BookOpen },
};

/** Put Notes, To Do and Journal in any order in the sidebar; remembered on this device. */
export default function NavOrderSetting() {
  const order = useNavOrder();
  const isDefault = order.every((id, i) => id === WRITING_PLACES[i]);
  return (
    <>
      <ol className="nav-order" aria-label="Sidebar order">
        {order.map((id, i) => {
          const { label, icon: Icon } = PLACES[id];
          return (
            <li key={id} className="nav-order__row">
              <Icon size={16} aria-hidden="true" />
              <span className="nav-order__label">{label}</span>
              <button
                type="button" className="nav-order__btn" disabled={i === 0}
                aria-label={`Move ${label} up`} onClick={() => setNavOrder(moved(order, id, -1))}
              ><ArrowUp size={15} aria-hidden="true" /></button>
              <button
                type="button" className="nav-order__btn" disabled={i === order.length - 1}
                aria-label={`Move ${label} down`} onClick={() => setNavOrder(moved(order, id, 1))}
              ><ArrowDown size={15} aria-hidden="true" /></button>
            </li>
          );
        })}
      </ol>
      {!isDefault && (
        <button type="button" className="nav-order__reset" onClick={() => setNavOrder(WRITING_PLACES)}>Reset order</button>
      )}
    </>
  );
}
