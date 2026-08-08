import { Navigate, Route, Routes } from 'react-router';

import { BoardListPage } from './routes/BoardListPage.jsx';
import { BoardPage } from './routes/BoardPage.jsx';
import { JoinOrgPage } from './routes/JoinOrgPage.jsx';
import { JoinPage } from './routes/JoinPage.jsx';
import { RequireAccount } from './shell/RequireAccount.jsx';
import { organizations } from './shell/organizations.js';
import { sharing } from './shell/sharing.js';

/**
 * The guard sits outside the routes rather than on each one: every route here
 * reads boards, and a signed-out user on /b/:id should meet the same gate as a
 * signed-out user on the list, then land where they were going.
 */
export function App() {
  return (
    <RequireAccount>
      <Routes>
        <Route path="/" element={<BoardListPage />} />
        {/* The same page with a scope in front of it, not a second one — an
            organization's boards are a board list, and two components would be
            two places to keep create, rename and move working. */}
        {organizations && <Route path="/o/:orgId" element={<BoardListPage />} />}
        <Route path="/b/:boardId" element={<BoardPage />} />
        {/* A build with no project behind it has no links to honour, so the
            route does not exist rather than existing and always failing. */}
        {sharing && <Route path="/join/:token" element={<JoinPage />} />}
        {/* Two segments, so it cannot be mistaken for a board token above. */}
        {organizations && <Route path="/join/org/:token" element={<JoinOrgPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RequireAccount>
  );
}
