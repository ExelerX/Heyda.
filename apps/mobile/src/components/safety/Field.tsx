import { TextInput, View, type KeyboardTypeOptions, type TextInputProps } from 'react-native';
import { radius, spacing, useTheme } from '../../lib/theme';
import { T } from '../ui';

/** A labelled text input in the app's style, with an optional character counter and error. */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  multiline,
  keyboardType,
  error,
  hint,
  counter,
  onBlur,
  onSubmitEditing,
  autoCapitalize,
  returnKeyType,
  accessibilityLabel,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  maxLength: number;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  error?: string;
  hint?: string;
  counter?: boolean;
  onBlur?: () => void;
  onSubmitEditing?: () => void;
  autoCapitalize?: TextInputProps['autoCapitalize'];
  returnKeyType?: TextInputProps['returnKeyType'];
  accessibilityLabel?: string;
}) {
  const t = useTheme();
  const near = value.length >= maxLength * 0.8;
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <T variant="small">{label}</T> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.textMuted}
        maxLength={maxLength}
        multiline={multiline}
        keyboardType={keyboardType}
        onBlur={onBlur}
        onSubmitEditing={onSubmitEditing}
        autoCapitalize={autoCapitalize}
        returnKeyType={returnKeyType}
        accessibilityLabel={accessibilityLabel ?? label ?? placeholder}
        style={{
          backgroundColor: t.surface,
          borderColor: error ? t.danger : t.border,
          borderWidth: 1,
          borderRadius: radius.md,
          color: t.text,
          fontSize: 16,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.md,
          minHeight: multiline ? 84 : 48,
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />
      {error ? (
        <T variant="small" color={t.danger}>
          {error}
        </T>
      ) : hint ? (
        <T variant="small">{hint}</T>
      ) : null}
      {counter && near ? (
        <T variant="small" style={{ alignSelf: 'flex-end' }}>
          {value.length}/{maxLength}
        </T>
      ) : null}
    </View>
  );
}
