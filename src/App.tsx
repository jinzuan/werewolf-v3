import { useEffect } from 'react';
import { BrowserRouter as Router } from 'react-router-dom';
import { AppRouter } from './app/router';
import { useV3Store } from './stores/v3Store';

export default function App() {
  const initialize = useV3Store((state) => state.initialize);

  useEffect(() => initialize(), [initialize]);

  return (
    <Router>
      <AppRouter />
    </Router>
  );
}
