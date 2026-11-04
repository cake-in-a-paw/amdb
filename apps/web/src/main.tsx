import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './lib/api';
import { authClient } from './lib/auth';
import { createAppRouter } from './router';
import './styles.css';

const router = createAppRouter({ api, auth: authClient });
const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
