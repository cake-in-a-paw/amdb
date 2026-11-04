import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWebApi } from './lib/api';
import { createBrowserAuthClient } from './lib/auth';
import { meQueryKey } from './lib/me';
import { createAppRouter } from './router';
import './styles.css';

// The client asks the router's cache who is signed in, so the two are built as a pair.
const api = createWebApi(() => Boolean(router.options.context.queryClient.getQueryData(meQueryKey)));
const router = createAppRouter({ api, auth: createBrowserAuthClient() });
const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
