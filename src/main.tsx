import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from './i18n';
import AuthGate from './components/AuthGate';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import ModelsPage from './pages/ModelsPage';
import ModelDetailPage from './pages/ModelDetailPage';
import ComparePage from './pages/ComparePage';
import LabPage from './pages/LabPage';
import MonitorPage from './pages/MonitorPage';
import BenchmarksPage from './pages/BenchmarksPage';
import ReportsPage from './pages/ReportsPage';
import ReportDetailPage from './pages/ReportDetailPage';
import CommunityPage from './pages/CommunityPage';
import SettingsPage from './pages/SettingsPage';
import CatalogPage from './pages/CatalogPage';
import NotFoundPage from './pages/NotFoundPage';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root was not found in index.html');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <AuthGate>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="models/:id" element={<ModelDetailPage />} />
            <Route path="compare" element={<ComparePage />} />
            <Route path="lab" element={<LabPage />} />
            <Route path="monitor" element={<MonitorPage />} />
            <Route path="benchmarks" element={<BenchmarksPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:publicId" element={<ReportDetailPage />} />
            <Route path="community" element={<CommunityPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="catalog" element={<CatalogPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
      </AuthGate>
    </I18nProvider>
  </StrictMode>,
);
