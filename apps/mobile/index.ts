// Custom entry: polyfills first, then background tasks (they must be defined at
// startup, also when the OS wakes the app without UI), then the router.
import './src/lib/polyfills';
import './src/lib/strict';
import './src/lib/background';
import 'expo-router/entry';
