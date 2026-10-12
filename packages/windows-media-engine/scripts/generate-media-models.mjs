// The media payload has one typed source of truth. Generate both boundary
// codecs and the native value types, including the same numeric/array bounds.
const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const title = (name) => name[0].toUpperCase() + name.slice(1)
const quote = JSON.stringify

export function generateMediaModels(models, maximumIdentifierLength) {
  const entries = Object.entries(models)
  const enumName = (model, field) => `${model}${title(field)}`
  const baseCppType = (model, name, field) => {
    switch (field.type) {
      case 'boolean': return 'bool'
      case 'integer': return 'std::uint64_t'
      case 'number': return 'double'
      case 'identifier': return 'std::string'
      case 'enum': return enumName(model, name)
      case 'array': return `std::vector<${field.item}>`
      default: throw new Error(`Unknown media field type: ${field.type}`)
    }
  }
  const cppType = (model, name, field) => field.nullable
    ? `std::optional<${baseCppType(model, name, field)}>`
    : baseCppType(model, name, field)
  const enums = entries.flatMap(([model, definition]) => [
    ...(definition.states ? [[enumName(model, 'state'), definition.states]] : []),
    ...Object.entries(definition.fields)
      .filter(([, field]) => field.type === 'enum')
      .map(([name, field]) => [enumName(model, name), field.values]),
  ])
  const types = `#pragma once
// Generated from protocol/media-lifecycle.json. Do not edit.
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace syrnike::windows_media {
${enums.map(([name, values]) => `enum class ${name} { ${values.join(', ')} };`).join('\n')}

${entries.map(([model, definition]) => `struct ${model} {
${definition.states ? `  ${enumName(model, 'state')} state = ${enumName(model, 'state')}::off;\n` : ''}${Object.entries(definition.fields).map(([name, field]) => `  ${cppType(model, name, field)} ${snake(name)}{};`).join('\n')}
  bool operator==(const ${model}&) const = default;
};`).join('\n\n')}

inline bool validMediaIdentifier(const std::string& value) {
  if (value.empty() || value.size() > ${maximumIdentifierLength}) return false;
  for (const unsigned char character : value) {
    if (character < 0x21 || character > 0x7e) return false;
  }
  return true;
}

${entries.map(([model, definition]) => `inline bool validMediaModel(const ${model}& value) {
${definition.states ? `  if (value.state == ${enumName(model, 'state')}::off) return true;
  if (${definition.states.filter(state => state !== 'off').map(state => `value.state != ${enumName(model, 'state')}::${state}`).join(' && ')}) return false;\n` : ''}${Object.entries(definition.fields).map(([name, field]) => {
    const member = `value.${snake(name)}`
    const expression = field.nullable ? `*${member}` : member
    let valid
    switch (field.type) {
      case 'boolean': return ''
      case 'identifier': valid = `validMediaIdentifier(${expression})`; break
      case 'integer': valid = `(${expression} >= ${field.minimum}ULL && ${expression} <= ${field.maximum}ULL)`; break
      case 'number': valid = `(std::isfinite(${expression}) && ${expression} >= ${field.minimum} && ${expression} <= ${field.maximum})`; break
      case 'enum': valid = `(${field.values.map(value => `${expression} == ${enumName(model, name)}::${value}`).join(' || ')})`; break
      case 'array': return `  if (${member}.size() > ${field.maximum}) return false;
  for (const auto& entry : ${member}) if (!validMediaModel(entry)) return false;`
    }
    return `  if (${field.nullable ? `${member} && ` : ''}!${valid}) return false;`
  }).filter(Boolean).join('\n')}
  return true;
}`).join('\n\n')}
} // namespace syrnike::windows_media
`

  const schemaFor = (field) => {
    let schema
    switch (field.type) {
      case 'boolean': schema = 'Schema.Boolean'; break
      case 'identifier': schema = 'identifier'; break
      case 'number': case 'integer':
        schema = `Schema.${field.type === 'integer' ? 'Int' : 'Finite'}.check(Schema.isBetween({ minimum: ${field.minimum}, maximum: ${field.maximum} }))`; break
      case 'enum': schema = `Schema.Literals(${quote(field.values)})`; break
      case 'array': schema = `Schema.Array(${field.item}Schema).check(Schema.isMaxLength(${field.maximum}))`; break
      default: throw new Error(`Unknown media field type: ${field.type}`)
    }
    return field.nullable ? `Schema.Union([${schema}, Schema.Null])` : schema
  }
  const schemas = `// Generated from protocol/media-lifecycle.json. Do not edit.
import { Schema } from 'effect'

const identifier = Schema.String.check(
  Schema.isMinLength(1), Schema.isMaxLength(${maximumIdentifierLength}),
  Schema.isPattern(/^[\\x21-\\x7e]+$/),
)

${entries.map(([model, definition]) => {
    const active = `Schema.Struct({
${definition.states ? `  state: Schema.Literals(${quote(definition.states.filter(state => state !== 'off'))}),\n` : ''}${Object.entries(definition.fields).map(([name, field]) => `  ${name}: ${schemaFor(field)},`).join('\n')}
})`
    return `export const ${model}Schema = ${definition.states ? `Schema.Union([Schema.Struct({ state: Schema.Literal('off') }), ${active}])` : active}
export type ${model} = typeof ${model}Schema.Type`
  }).join('\n\n')}
`

  const decodeExpression = (model, name, field, value) => {
    switch (field.type) {
      case 'boolean': return `readBoolean(env, ${value})`
      case 'identifier': return `readIdentifier(env, ${value})`
      case 'number': return `readNumber(env, ${value}, ${field.minimum}, ${field.maximum}, false)`
      case 'integer': return `static_cast<std::uint64_t>(readNumber(env, ${value}, ${field.minimum}, ${field.maximum}, true))`
      case 'enum': return `read${enumName(model, name)}(env, ${value})`
      case 'array': return `readArray<${field.item}>(env, ${value}, ${field.maximum}, read${field.item})`
      default: throw new Error(`Unknown media field type: ${field.type}`)
    }
  }
  const encodeExpression = (field, expression) => field.type === 'enum'
    ? `writeEnum(env, ${expression})`
    : field.type === 'array' ? `writeArray(env, ${expression})`
      : field.type === 'integer' ? `Napi::Number::New(env, static_cast<double>(${expression}))`
        : expression
  const codecs = `#pragma once
// Generated from protocol/media-lifecycle.json. Do not edit.
#include <napi.h>
#include "core/media_models.generated.hpp"

namespace syrnike::windows_media::media_codec {
[[noreturn]] inline void invalid(Napi::Env env) {
  auto error = Napi::TypeError::New(env, "Invalid bounded media intent");
  error.Value().Set("code", "desired_state_invalid");
  error.Value().Set("stage", "binding_decode");
  error.Value().Set("retryable", false);
  throw error;
}
inline Napi::Object readObject(Napi::Env env, const Napi::Value& value) {
  if (!value.IsObject() || value.IsNull() || value.IsArray()) invalid(env);
  return value.As<Napi::Object>();
}
inline bool readBoolean(Napi::Env env, const Napi::Value& value) {
  if (!value.IsBoolean()) invalid(env);
  return value.As<Napi::Boolean>().Value();
}
inline double readNumber(Napi::Env env, const Napi::Value& value,
                         double minimum, double maximum, bool integer) {
  if (!value.IsNumber()) invalid(env);
  const auto number = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < minimum || number > maximum ||
      (integer && std::floor(number) != number)) invalid(env);
  return number;
}
inline std::string readIdentifier(Napi::Env env, const Napi::Value& value) {
  if (!value.IsString()) invalid(env);
  std::size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length == 0 || length > ${maximumIdentifierLength}) invalid(env);
  std::string text(length + 1, '\\0');
  std::size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, text.data(), text.size(), &copied) != napi_ok ||
      copied != length) invalid(env);
  text.resize(length);
  if (!validMediaIdentifier(text)) invalid(env);
  return text;
}
template<typename T, typename Read>
std::vector<T> readArray(Napi::Env env, const Napi::Value& value, std::size_t maximum, Read read) {
  if (!value.IsArray()) invalid(env);
  const auto array = value.As<Napi::Array>();
  if (array.Length() > maximum) invalid(env);
  std::vector<T> entries;
  entries.reserve(array.Length());
  for (std::uint32_t index = 0; index < array.Length(); ++index)
    entries.push_back(read(env, array.Get(index)));
  return entries;
}

${enums.map(([name, values]) => `inline ${name} read${name}(Napi::Env env, const Napi::Value& value) {
  const auto text = readIdentifier(env, value);
${values.map(value => `  if (text == ${quote(value)}) return ${name}::${value};`).join('\n')}
  invalid(env);
}
inline Napi::String writeEnum(Napi::Env env, ${name} value) {
  switch (value) {
${values.map(value => `    case ${name}::${value}: return Napi::String::New(env, ${quote(value)});`).join('\n')}
  }
  invalid(env);
}`).join('\n\n')}

${entries.map(([model]) => `inline Napi::Object writeModel(Napi::Env, const ${model}&);`).join('\n')}
template<typename T>
Napi::Array writeArray(Napi::Env env, const std::vector<T>& entries) {
  auto array = Napi::Array::New(env, entries.size());
  for (std::size_t index = 0; index < entries.size(); ++index)
    array.Set(static_cast<std::uint32_t>(index), writeModel(env, entries[index]));
  return array;
}

${entries.map(([model, definition]) => `inline ${model} read${model}(Napi::Env env, const Napi::Value& value) {
  const auto object = readObject(env, value);
  ${model} result;
${definition.states ? `  result.state = read${enumName(model, 'state')}(env, object.Get("state"));
  if (result.state == ${enumName(model, 'state')}::off) return result;\n` : ''}${Object.entries(definition.fields).map(([name, field]) => {
    const value = `object.Get(${quote(name)})`
    const assignment = `result.${snake(name)} = ${decodeExpression(model, name, field, value)};`
    return field.nullable ? `  if (!${value}.IsNull()) ${assignment}` : `  ${assignment}`
  }).join('\n')}
  return result;
}
inline Napi::Object writeModel(Napi::Env env, const ${model}& value) {
  auto object = Napi::Object::New(env);
${definition.states ? `  object.Set("state", writeEnum(env, value.state));
  if (value.state == ${enumName(model, 'state')}::off) return object;\n` : ''}${Object.entries(definition.fields).map(([name, field]) => {
    const member = `value.${snake(name)}`
    return field.nullable
      ? `  if (${member}) object.Set(${quote(name)}, ${encodeExpression(field, `*${member}`)});
  else object.Set(${quote(name)}, env.Null());`
      : `  object.Set(${quote(name)}, ${encodeExpression(field, member)});`
  }).join('\n')}
  return object;
}`).join('\n\n')}
} // namespace syrnike::windows_media::media_codec
`
  return { types, schemas, codecs }
}
