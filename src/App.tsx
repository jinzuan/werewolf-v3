import { BrowserRouter as Router } from 'react-router-dom';
import { AppRouter } from './app/router';

export default function App() {
  return (
    <Router>
      <AppRouter />
    </Router>
  );
}
