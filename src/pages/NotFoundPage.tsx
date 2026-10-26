import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n';

export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
      <AlertTriangle className="h-8 w-8 text-[#F3B66D]" aria-hidden="true" />
      <div className="space-y-1.5">
        <h1 className="text-lg font-semibold text-lab-text">{t('state.errorNotFound')}</h1>
        <p className="text-xs text-lab-muted">404</p>
      </div>
      <Link to="/" className="lab-btn-secondary text-xs">
        {t('nav.home')}
      </Link>
    </div>
  );
}
