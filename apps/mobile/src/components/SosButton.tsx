import { useRouter } from 'expo-router';
import { Button } from './ui';

/** Opens the SOS screen. (Placeholder, replaced by the safety screens.) */
export function SosButton({ compact }: { compact?: boolean }) {
  const router = useRouter();
  return <Button title="SOS" kind="danger" compact={compact} onPress={() => router.push('/sos')} />;
}
