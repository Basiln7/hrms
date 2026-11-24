import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, UserRound } from 'lucide-react';
import { useAuth, useMe } from '../context/AuthContext';
import { ThemeToggle } from './controls';
import { Avatar, useClickOutside } from './ui';

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { logout } = useAuth();
  const { employee, company } = useMe();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useClickOutside(menuRef, useCallback(() => setOpen(false), []), open);

  return (
    <header className="topbar">
      <button type="button" className="icon-btn only-mobile" onClick={onMenu} aria-label="Open navigation">
        <Menu size={20} />
      </button>
      <span className="topbar-company">{company.name}</span>
      <div className="topbar-spacer" />

      <div className="topbar-actions">
        <ThemeToggle />
        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="user-chip" onClick={() => setOpen((o) => !o)} aria-label="Account menu" aria-expanded={open} aria-haspopup="menu">
            <Avatar name={employee.name} size={36} />
            <ChevronDown size={16} />
          </button>
          {open && (
            <div className="popover menu" role="menu">
              <div className="menu-head">
                <b>{employee.name}</b>
                <span>
                  {employee.role} · {employee.code}
                </span>
                <span>{employee.email}</span>
              </div>
              <button
                type="button"
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  navigate('/profile');
                }}
              >
                <UserRound size={17} /> My profile
              </button>
              <button type="button" className="menu-item" role="menuitem" onClick={() => void logout()}>
                <LogOut size={17} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
