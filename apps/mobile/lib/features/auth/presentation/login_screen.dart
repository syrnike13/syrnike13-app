import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/config/app_config.dart';
import '../application/auth_controller.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _mfaController = TextEditingController();

  String? _emailError;
  String? _passwordError;
  String? _mfaError;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _mfaController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);

    if (auth.mfaChallenge != null) {
      return _AuthScaffold(
        child: _AuthCard(
          title: 'Двухфакторная аутентификация',
          description:
              'Подтвердите вход паролем. Доступные методы: ${auth.mfaChallenge!.allowedMethods.join(', ')}',
          errorMessage: auth.errorMessage,
          footer: Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: auth.busy
                      ? null
                      : () {
                          _mfaController.clear();
                          setState(() => _mfaError = null);
                          ref.read(authControllerProvider.notifier).cancelMfa();
                        },
                  child: const Text('Назад'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: FilledButton(
                  onPressed: auth.busy ? null : () => _submitMfa(auth),
                  child: _ButtonContent(busy: auth.busy, label: 'Подтвердить'),
                ),
              ),
            ],
          ),
          children: [
            _LabeledField(
              label: 'Пароль',
              child: TextField(
                controller: _mfaController,
                obscureText: true,
                autofillHints: const [AutofillHints.password],
                onSubmitted: (_) => _submitMfa(auth),
                decoration: InputDecoration(errorText: _mfaError),
              ),
            ),
          ],
        ),
      );
    }

    return _AuthScaffold(
      child: _AuthCard(
        title: 'Вход в syrnike13',
        description:
            'Используется API (${_apiHost(ref.watch(appConfigProvider).apiUrl)})',
        errorMessage: auth.errorMessage,
        footer: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton(
              onPressed: auth.busy ? null : () => _submitPassword(auth),
              child: _ButtonContent(busy: auth.busy, label: 'Войти'),
            ),
            const SizedBox(height: 12),
            _AuthLink(
              label: 'Создать аккаунт',
              prominent: true,
              onPressed: () => context.go('/login/register'),
            ),
            _AuthLink(
              label: 'Забыли пароль?',
              onPressed: () => _showPendingScreen('Сброс пароля'),
            ),
            _AuthLink(
              label: 'На главную',
              onPressed: () => _showPendingScreen('Главная'),
            ),
          ],
        ),
        children: [
          _LabeledField(
            label: 'Email',
            child: TextField(
              controller: _emailController,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              autofillHints: const [AutofillHints.email],
              decoration: InputDecoration(errorText: _emailError),
            ),
          ),
          const SizedBox(height: 16),
          _LabeledField(
            label: 'Пароль',
            child: TextField(
              controller: _passwordController,
              obscureText: true,
              autofillHints: const [AutofillHints.password],
              onSubmitted: (_) => _submitPassword(auth),
              decoration: InputDecoration(errorText: _passwordError),
            ),
          ),
        ],
      ),
    );
  }

  void _submitPassword(AuthState auth) {
    if (auth.busy) return;

    final email = _emailController.text.trim();
    final password = _passwordController.text;
    final emailValid = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email);

    setState(() {
      _emailError = emailValid ? null : 'Введите корректный email';
      _passwordError = password.isEmpty ? 'Введите пароль' : null;
    });

    if (_emailError != null || _passwordError != null) return;

    ref
        .read(authControllerProvider.notifier)
        .login(email: email, password: password);
  }

  void _submitMfa(AuthState auth) {
    if (auth.busy) return;

    final password = _mfaController.text;
    setState(() {
      _mfaError = password.isEmpty ? 'Введите пароль' : null;
    });

    if (_mfaError != null) return;

    ref.read(authControllerProvider.notifier).submitMfaPassword(password);
  }

  void _showPendingScreen(String name) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('$name будет перенесён следующим этапом.')),
    );
  }
}

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _inviteController = TextEditingController();

  String? _emailError;
  String? _passwordError;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _inviteController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);

    return _AuthScaffold(
      child: _AuthCard(
        title: 'Регистрация',
        description:
            'Создайте аккаунт на syrnike13.ru\nПодтверждение по почте на сервере отключено — после регистрации сразу выберете ник и войдёте.',
        errorMessage: auth.errorMessage,
        footer: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            FilledButton(
              onPressed: auth.busy ? null : () => _submit(auth),
              child: _ButtonContent(
                busy: auth.busy,
                label: 'Зарегистрироваться',
              ),
            ),
            const SizedBox(height: 10),
            _AuthLink(
              label: 'Уже есть аккаунт',
              onPressed: () => context.go('/login'),
            ),
          ],
        ),
        children: [
          _LabeledField(
            label: 'Email',
            child: TextField(
              controller: _emailController,
              keyboardType: TextInputType.emailAddress,
              textInputAction: TextInputAction.next,
              autofillHints: const [AutofillHints.email],
              decoration: InputDecoration(errorText: _emailError),
            ),
          ),
          const SizedBox(height: 16),
          _LabeledField(
            label: 'Пароль',
            child: TextField(
              controller: _passwordController,
              obscureText: true,
              textInputAction: TextInputAction.next,
              autofillHints: const [AutofillHints.newPassword],
              decoration: InputDecoration(errorText: _passwordError),
            ),
          ),
          const SizedBox(height: 16),
          _LabeledField(
            label: 'Код приглашения (если нужен)',
            child: TextField(
              controller: _inviteController,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _submit(auth),
            ),
          ),
        ],
      ),
    );
  }

  void _submit(AuthState auth) {
    if (auth.busy) return;

    final email = _emailController.text.trim();
    final password = _passwordController.text;
    final emailValid = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email);

    setState(() {
      _emailError = emailValid ? null : 'Введите корректный email';
      _passwordError = password.length >= 8 ? null : 'Минимум 8 символов';
    });

    if (_emailError != null || _passwordError != null) return;

    ref
        .read(authControllerProvider.notifier)
        .register(
          email: email,
          password: password,
          invite: _inviteController.text,
        );
  }
}

class OnboardScreen extends ConsumerStatefulWidget {
  const OnboardScreen({super.key});

  @override
  ConsumerState<OnboardScreen> createState() => _OnboardScreenState();
}

class _OnboardScreenState extends ConsumerState<OnboardScreen> {
  final _usernameController = TextEditingController();
  String? _usernameError;

  @override
  void dispose() {
    _usernameController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = ref.watch(authControllerProvider);

    return _AuthScaffold(
      child: _AuthCard(
        title: 'Выберите ник',
        description:
            'По нему вас смогут найти. Позже можно изменить в настройках профиля.',
        errorMessage: auth.errorMessage,
        footer: FilledButton(
          onPressed: auth.busy ? null : () => _submit(auth),
          child: _ButtonContent(busy: auth.busy, label: 'Продолжить'),
        ),
        children: [
          _LabeledField(
            label: 'Имя пользователя',
            child: TextField(
              controller: _usernameController,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.username],
              autocorrect: false,
              enableSuggestions: false,
              onSubmitted: (_) => _submit(auth),
              decoration: InputDecoration(errorText: _usernameError),
            ),
          ),
        ],
      ),
    );
  }

  void _submit(AuthState auth) {
    if (auth.busy) return;

    final username = _usernameController.text.trim();
    final valid = RegExp(
      r'^[a-z0-9_]{2,32}$',
      caseSensitive: false,
    ).hasMatch(username);

    setState(() {
      _usernameError = valid
          ? null
          : 'Только латиница, цифры и подчёркивание, 2-32 символа';
    });

    if (_usernameError != null) return;

    ref.read(authControllerProvider.notifier).completeOnboarding(username);
  }
}

class _AuthScaffold extends StatelessWidget {
  const _AuthScaffold({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 448),
              child: child,
            ),
          ),
        ),
      ),
    );
  }
}

class _AuthCard extends StatelessWidget {
  const _AuthCard({
    required this.title,
    required this.description,
    required this.children,
    required this.footer,
    this.errorMessage,
  });

  final String title;
  final String description;
  final List<Widget> children;
  final Widget footer;
  final String? errorMessage;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w600,
                height: 1,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              description,
              style: textTheme.bodyMedium?.copyWith(
                color: scheme.onSurfaceVariant,
                height: 1.35,
              ),
            ),
            const SizedBox(height: 24),
            if (errorMessage != null) ...[
              _StatusBanner(text: errorMessage!),
              const SizedBox(height: 16),
            ],
            ...children,
            const SizedBox(height: 24),
            footer,
          ],
        ),
      ),
    );
  }
}

class _LabeledField extends StatelessWidget {
  const _LabeledField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(
            context,
          ).textTheme.labelMedium?.copyWith(fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 8),
        child,
      ],
    );
  }
}

class _ButtonContent extends StatelessWidget {
  const _ButtonContent({required this.busy, required this.label});

  final bool busy;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (busy) ...[
          const SizedBox.square(
            dimension: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: 8),
        ],
        Text(label),
      ],
    );
  }
}

class _AuthLink extends StatelessWidget {
  const _AuthLink({
    required this.label,
    required this.onPressed,
    this.prominent = false,
  });

  final String label;
  final VoidCallback onPressed;
  final bool prominent;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return TextButton(
      onPressed: onPressed,
      child: Text(
        label,
        style: TextStyle(
          color: prominent ? scheme.primary : scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.error.withValues(alpha: 0.35)),
        color: scheme.error.withValues(alpha: 0.08),
      ),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.error_outline_rounded, color: scheme.error),
            const SizedBox(width: 10),
            Expanded(child: Text(text)),
          ],
        ),
      ),
    );
  }
}

String _apiHost(String url) {
  return url.replaceFirst(RegExp(r'^https?://'), '');
}
