import { Navigate, Route, Routes } from 'react-router';

import { BoardListPage } from './routes/BoardListPage.jsx';
import { BoardPage } from './routes/BoardPage.jsx';
import { JoinPage } from './routes/JoinPage.jsx';
import { RequireAccount } from './shell/RequireAccount.jsx';
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
        <Route path="/b/:boardId" element={<BoardPage />} />
        {/* A build with no project behind it has no links to honour, so the
            route does not exist rather than existing and always failing. */}
        {sharing && <Route path="/join/:token" element={<JoinPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </RequireAccount>
  );
}
