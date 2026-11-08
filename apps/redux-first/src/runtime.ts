import {
  Layer,
  ManagedRuntime
} from 'effect';
import {
  useEffect,
  useRef,
  useState
} from 'react';

/** The demo, not the store, owns its lazily initialized application runtime. */
export function useDemoRuntime(): ManagedRuntime.ManagedRuntime<never, never> {
  const [runtime] = useState(() => ManagedRuntime.make(Layer.empty));

  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      // Strict Mode reclaims the same runtime before this microtask executes.
      queueMicrotask(() => {
        if (!mounted.current) {
          void runtime.dispose().catch((error: unknown) => {
            console.error('Application runtime disposal failed.', error);
          });
        }
      });
    };
  }, [runtime]);

  return runtime;
}
