import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';
import '../../../core/storage/secure_session_store.dart';
import '../data/auth_api.dart';
import '../data/auth_models.dart';

final authControllerProvider = NotifierProvider<AuthController, AuthState>(
  AuthController.new,
);

enum AuthPhase { loading, unauthenticated, authenticated, onboardingRequired }

class AuthState {
  const AuthState({
    required this.phase,
    this.session,
    this.user,
    this.mfaChallenge,
    this.errorMessage,
    this.busy = false,
  });

  const AuthState.loading() : this(phase: AuthPhase.loading);

  final AuthPhase phase;
  final Session? session;
  final SyrnikeUser? user;
  final LoginMfa? mfaChallenge;
  final String? errorMessage;
  final bool busy;

  bool get isAuthenticated =>
      phase == AuthPhase.authenticated || phase == AuthPhase.onboardingRequired;

  AuthState copyWith({
    AuthPhase? phase,
    Session? session,
    SyrnikeUser? user,
    LoginMfa? mfaChallenge,
    String? errorMessage,
    bool? busy,
    bool clearMfa = false,
    bool clearError = false,
  }) {
    return AuthState(
      phase: phase ?? this.phase,
      session: session ?? this.session,
      user: user ?? this.user,
      mfaChallenge: clearMfa ? null : mfaChallenge ?? this.mfaChallenge,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
      busy: busy ?? this.busy,
    );
  }
}

class AuthController extends Notifier<AuthState> {
  late AuthApi _api;
  late SecureSessionStore _store;

  @override
  AuthState build() {
    _api = ref.watch(authApiProvider);
    _store = ref.watch(secureSessionStoreProvider);
    Future<void>.microtask(hydrate);
    return const AuthState.loading();
  }

  Future<void> hydrate() async {
    state = state.copyWith(
      phase: AuthPhase.loading,
      clearError: true,
      clearMfa: true,
    );

    final session = await _store.read();
    if (session == null) {
      state = const AuthState(phase: AuthPhase.unauthenticated);
      return;
    }

    await _applySession(session);
  }

  Future<void> login({required String email, required String password}) async {
    state = state.copyWith(busy: true, clearError: true);
    try {
      final response = await _api.loginWithPassword(
        email: email.trim(),
        password: password,
      );
      await _handleLoginResponse(response);
    } catch (error) {
      state = state.copyWith(errorMessage: _friendlyError(error), busy: false);
    }
  }

  Future<void> register({
    required String email,
    required String password,
    String? invite,
  }) async {
    state = state.copyWith(busy: true, clearError: true);
    try {
      await _api.createAccount(
        email: email.trim(),
        password: password,
        invite: invite,
      );
      final response = await _api.loginWithPassword(
        email: email.trim(),
        password: password,
      );
      await _handleLoginResponse(response);
    } catch (error) {
      state = state.copyWith(errorMessage: _friendlyError(error), busy: false);
    }
  }

  Future<void> submitMfaPassword(String password) async {
    final challenge = state.mfaChallenge;
    if (challenge == null) return;

    state = state.copyWith(busy: true, clearError: true);
    try {
      final response = await _api.loginWithMfaPassword(
        ticket: challenge.ticket,
        password: password,
      );
      await _handleLoginResponse(response);
    } catch (error) {
      state = state.copyWith(errorMessage: _friendlyError(error), busy: false);
    }
  }

  void cancelMfa() {
    state = state.copyWith(clearMfa: true, clearError: true, busy: false);
  }

  void replaceCurrentUser(SyrnikeUser user) {
    if (state.user?.id != user.id) return;
    state = state.copyWith(user: user);
  }

  Future<void> completeOnboarding(String username) async {
    final session = state.session;
    if (session == null) return;

    state = state.copyWith(busy: true, clearError: true);
    try {
      final user = await _api.completeOnboarding(
        token: session.token,
        username: username.trim(),
      );
      state = AuthState(
        phase: AuthPhase.authenticated,
        session: session,
        user: user,
      );
    } catch (error) {
      state = state.copyWith(errorMessage: _friendlyError(error), busy: false);
    }
  }

  Future<void> logout() async {
    final token = state.session?.token;
    state = state.copyWith(busy: true, clearError: true);

    if (token != null) {
      try {
        await _api.logout(token);
      } catch (_) {
        // Local session cleanup is more important than a best-effort server logout.
      }
    }

    await _store.clear();
    state = const AuthState(phase: AuthPhase.unauthenticated);
  }

  Future<void> _handleLoginResponse(LoginResponse response) async {
    switch (response) {
      case LoginSuccess(:final session):
        await _store.write(session);
        await _applySession(session);
      case LoginMfa():
        state = state.copyWith(
          phase: AuthPhase.unauthenticated,
          mfaChallenge: response,
          busy: false,
        );
      case LoginDisabled():
        state = state.copyWith(
          phase: AuthPhase.unauthenticated,
          errorMessage: 'Аккаунт отключён.',
          busy: false,
        );
    }
  }

  Future<void> _applySession(Session session) async {
    try {
      final onboarding = await _api.fetchOnboardingStatus(session.token);
      if (onboarding.required) {
        state = AuthState(
          phase: AuthPhase.onboardingRequired,
          session: session,
          busy: false,
        );
        return;
      }

      final user = await _api.fetchCurrentUser(session.token);
      state = AuthState(
        phase: AuthPhase.authenticated,
        session: session,
        user: user,
      );
    } catch (error) {
      if (error is ApiException && error.statusCode == 401) {
        await _store.clear();
        state = const AuthState(phase: AuthPhase.unauthenticated);
        return;
      }

      state = AuthState(
        phase: AuthPhase.unauthenticated,
        errorMessage: _friendlyError(error),
      );
    }
  }

  String _friendlyError(Object error) {
    if (error is ApiException) return error.message;
    return 'Не удалось выполнить запрос. Проверьте подключение.';
  }
}
