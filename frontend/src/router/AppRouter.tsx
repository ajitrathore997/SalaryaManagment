import { Routes, Route } from 'react-router-dom';
import AppLayout from '@/layouts/AppLayout';
import DashboardPage from '@/pages/DashboardPage';
import NotFoundPage from '@/pages/NotFoundPage';

export default function AppRouter() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<DashboardPage />} />
        {/* Additional routes will be added as features are built */}
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
