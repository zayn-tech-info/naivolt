/**
 * ErrorBoundary.
 *
 * Previously this caught render errors, logged them to the console, and showed
 * the raw `error.message` on a dead-end screen. Three problems with that in
 * production: nobody sees a console log on a user's phone, a React error message
 * means nothing to the person reading it, and there was no way out of the screen
 * short of force-quitting.
 *
 * Now it reports to Sentry, says something a user can act on, and offers a retry
 * that remounts the tree — which recovers from the common case of a transient
 * render failure without the user having to kill the app.
 *
 * The raw message stays visible in development only, where it's the useful part.
 */

import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { reportError } from '@/services/monitoring';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  /** Bumped on retry to force a fresh subtree. */
  generation: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, generation: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportError(error, { componentStack: errorInfo.componentStack });
  }

  handleRetry = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      generation: prev.generation + 1,
    }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            The app hit an unexpected problem. Your balance and transactions are safe.
          </Text>

          <Pressable
            onPress={this.handleRetry}
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>

          {__DEV__ && this.state.error ? (
            <Text style={styles.debug}>{this.state.error.message}</Text>
          ) : null}
        </View>
      );
    }

    return <React.Fragment key={this.state.generation}>{this.props.children}</React.Fragment>;
  }
}

// Hard-coded rather than themed: the theme provider may be the thing that
// crashed, so this screen cannot depend on it.
const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
    backgroundColor: '#08090A',
  },
  title: {
    fontSize: 19,
    fontWeight: '600',
    color: '#F2F4F5',
    marginBottom: 8,
    textAlign: 'center',
  },
  message: {
    fontSize: 15,
    lineHeight: 22,
    color: '#8B939C',
    textAlign: 'center',
    maxWidth: 300,
  },
  button: {
    marginTop: 28,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 24,
    borderRadius: 14,
    backgroundColor: '#AAFF00',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0A0F00',
  },
  debug: {
    marginTop: 28,
    fontSize: 12,
    color: '#5B636B',
    textAlign: 'center',
  },
});
