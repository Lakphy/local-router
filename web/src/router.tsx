import { createRootRoute, createRoute, createRouter, Navigate } from '@tanstack/react-router';
import App from '@/App';
import { ChatPage } from '@/pages/chat';
import { DashboardPage } from '@/pages/dashboard';
import { LogDetailPage } from '@/pages/log-detail';
import { LogsPage } from '@/pages/logs';
import { LogsSettingsPage } from '@/pages/logs-settings';
import { ProvidersPage } from '@/pages/providers';
import { RoutesPage } from '@/pages/routes';
import { SessionsPage } from '@/pages/sessions';

const rootRoute = createRootRoute({
  component: App,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => <Navigate to="/dashboard" replace />,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: DashboardPage,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatPage,
});

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers',
  component: ProvidersPage,
});

const routesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/routes',
  component: RoutesPage,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs',
  validateSearch: (search: Record<string, unknown>) => ({
    user: typeof search.user === 'string' ? search.user : undefined,
    session: typeof search.session === 'string' ? search.session : undefined,
  }),
  component: LogsPage,
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsPage,
});

const logDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs/$id',
  component: LogDetailPage,
});

const logsSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logs-settings',
  component: LogsSettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  chatRoute,
  providersRoute,
  routesRoute,
  logsRoute,
  sessionsRoute,
  logDetailRoute,
  logsSettingsRoute,
]);

export const router = createRouter({
  routeTree,
  basepath: '/admin',
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
