import { enableStrictRuntime } from '@heyda/core';

// No eval anywhere: required by the Windows app's Content Security Policy, harmless elsewhere.
enableStrictRuntime();
