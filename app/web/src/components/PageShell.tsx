import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

/** Standard content wrapper: page title + body, on the light (--bg) canvas. */
export default function PageShell({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Box component="main" sx={{ p: '20px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h5" sx={{ fontWeight: 800, color: '#1e2536' }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}
