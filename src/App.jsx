import { Navigate, Route, Routes } from 'react-router';

import { BoardListPage } from './routes/BoardListPage.jsx';
import { BoardPage } from './routes/BoardPage.jsx';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<BoardListPage />} />
      <Route path="/b/:boardId" element={<BoardPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
