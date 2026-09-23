import {
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Typography,
  Grid,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import StorageIcon from '@mui/icons-material/Storage';
import PeopleOutlineIcon from '@mui/icons-material/PeopleOutline';
import PublicIcon from '@mui/icons-material/Public';
import { useEffect, useState } from 'react';

interface HealthData {
  status: string;
  service: string;
  timestamp: string;
  uptime: number;
  environment: string;
}

interface StatCardProps {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
}

function StatCard({ title, value, subtitle, icon }: StatCardProps) {
  return (
    <Card>
      <CardContent>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Box>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              {title}
            </Typography>
            <Typography variant="h4" fontWeight={700} color="primary">
              {value}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {subtitle}
            </Typography>
          </Box>
          <Box sx={{ color: 'primary.main', opacity: 0.7 }}>{icon}</Box>
        </Box>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setHealthLoading(true);

    fetch('/api/health', { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<HealthData>;
      })
      .then(setHealth)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name !== 'AbortError') {
          setHealthError(err.message);
        }
      })
      .finally(() => setHealthLoading(false));

    return () => controller.abort();
  }, []);

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Dashboard
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 4 }}>
        Welcome to the Salary Management platform. Use the navigation to explore pay data and
        insights.
      </Typography>

      {/* Placeholder stat cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Total Employees"
            value="10,000"
            subtitle="Across all regions"
            icon={<PeopleOutlineIcon sx={{ fontSize: 40 }} />}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Countries"
            value="—"
            subtitle="Multi-country support"
            icon={<PublicIcon sx={{ fontSize: 40 }} />}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Pay Grades"
            value="—"
            subtitle="Grade bands configured"
            icon={<StorageIcon sx={{ fontSize: 40 }} />}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            title="Pending Reviews"
            value="—"
            subtitle="Salary reviews open"
            icon={<CheckCircleIcon sx={{ fontSize: 40 }} />}
          />
        </Grid>
      </Grid>

      {/* API health status card */}
      <Card sx={{ maxWidth: 480 }}>
        <CardContent>
          <Typography variant="h6" fontWeight={600} gutterBottom>
            API Health
          </Typography>

          {healthLoading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">
                Checking backend…
              </Typography>
            </Box>
          )}

          {healthError && (
            <Chip
              label={`Backend unreachable — ${healthError}`}
              color="error"
              size="small"
              variant="outlined"
            />
          )}

          {health && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                <Chip label={health.status.toUpperCase()} color="success" size="small" />
                <Typography variant="body2" color="text.secondary">
                  {health.service}
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary">
                Environment: <strong>{health.environment}</strong> · Uptime: {health.uptime}s
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Last checked: {new Date(health.timestamp).toLocaleTimeString()}
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
