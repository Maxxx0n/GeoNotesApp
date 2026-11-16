import { LogBox } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ARView from './src/screens/ARView';

// Hide the in-app warning/error banner (dev builds only — release builds never show it).
// Warnings still print in the Metro terminal.
LogBox.ignoreAllLogs();

export default function App() {
  return (
    <SafeAreaProvider style={{ backgroundColor: '#000' }}>
      <ARView />
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
