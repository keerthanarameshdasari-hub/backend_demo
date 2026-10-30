import 'reflect-metadata';
import { TEST_ENV } from './test-env';

// The app reads config through loadEnv(); give tests a complete dummy set.
Object.assign(process.env, TEST_ENV);
