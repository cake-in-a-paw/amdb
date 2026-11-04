import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// Each test boots PGlite and runs the migrations before its first render, and the first render in
// a file cold-loads the route tree; under a parallel full run that can pass Testing Library's 1s
// default. Waits stop as soon as the condition holds, so a generous ceiling costs nothing.
configure({ asyncUtilTimeout: 10_000 });

// jsdom doesn't implement scrolling; the router restores scroll position on navigation.
window.scrollTo = () => {};
