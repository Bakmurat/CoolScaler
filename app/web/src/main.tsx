import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import GlobalStyles from '@mui/material/GlobalStyles';
import App from './App';
import { theme, palette } from './theme';
import FeedbackProvider from './providers/FeedbackProvider';
import ClusterDataProvider from './providers/ClusterDataProvider';
import PromptProvider from './components/PromptModal';

const globalStyles = (
  <GlobalStyles
    styles={{
      body: {
        background: `radial-gradient(1200px 480px at 85% -8%, rgba(99,102,241,.08), transparent 60%),
                     radial-gradient(900px 420px at -5% 0%, rgba(34,197,94,.06), transparent 55%),
                     ${palette.bg}`,
        WebkitFontSmoothing: 'antialiased',
        textRendering: 'optimizeLegibility',
        letterSpacing: '-0.01em',
      },
      '::-webkit-scrollbar': { height: 9, width: 9 },
      '::-webkit-scrollbar-thumb': { background: '#d6d9e3', borderRadius: 9 },
      '::-webkit-scrollbar-track': { background: 'transparent' },
    }}
  />
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {globalStyles}
      <BrowserRouter>
        <FeedbackProvider>
          <PromptProvider>
            <ClusterDataProvider>
              <App />
            </ClusterDataProvider>
          </PromptProvider>
        </FeedbackProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
