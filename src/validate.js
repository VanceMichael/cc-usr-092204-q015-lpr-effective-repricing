// 轻量结构校验：覆盖本仓库交换契约所用的 JSON Schema 子集，不引入外部依赖。
export function validateSchema(schema, data, path = "$") {
  const errors = [];
  const fail = (message) => errors.push(`${path}: ${message}`);

  if (Array.isArray(schema.type)) {
    const matched = schema.type.some((type) => validateSchema({ ...schema, type }, data, path).length === 0);
    if (!matched) fail(`类型须为 ${schema.type.join(" | ")}`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(data)) fail(`须为枚举值之一 ${JSON.stringify(schema.enum)}`);

  switch (schema.type) {
    case "object": {
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        fail("须为对象");
        break;
      }
      for (const key of schema.required ?? []) {
        if (!(key in data)) fail(`缺少必填字段 ${key}`);
      }
      const properties = schema.properties ?? {};
      for (const [key, value] of Object.entries(data)) {
        if (properties[key]) {
          errors.push(...validateSchema(properties[key], value, `${path}.${key}`));
        } else if (schema.additionalProperties === false) {
          fail(`不允许的字段 ${key}`);
        } else if (typeof schema.additionalProperties === "object") {
          errors.push(...validateSchema(schema.additionalProperties, value, `${path}.${key}`));
        }
      }
      break;
    }
    case "array": {
      if (!Array.isArray(data)) {
        fail("须为数组");
        break;
      }
      if (schema.minItems !== undefined && data.length < schema.minItems) fail(`至少 ${schema.minItems} 项`);
      if (schema.items) {
        data.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${path}[${index}]`)));
      }
      break;
    }
    case "string": {
      if (typeof data !== "string") {
        fail("须为字符串");
        break;
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(data)) fail(`须匹配模式 ${schema.pattern}`);
      if (schema.minLength !== undefined && data.length < schema.minLength) fail(`长度至少 ${schema.minLength}`);
      break;
    }
    case "integer": {
      if (!Number.isInteger(data)) fail("须为整数");
      else checkBounds(schema, data, fail);
      break;
    }
    case "number": {
      if (typeof data !== "number" || Number.isNaN(data)) fail("须为数值");
      else checkBounds(schema, data, fail);
      break;
    }
    case "boolean": {
      if (typeof data !== "boolean") fail("须为布尔值");
      break;
    }
    case "null": {
      if (data !== null) fail("须为 null");
      break;
    }
    default:
      break;
  }
  return errors;
}

function checkBounds(schema, data, fail) {
  if (schema.minimum !== undefined && data < schema.minimum) fail(`须 >= ${schema.minimum}`);
  if (schema.maximum !== undefined && data > schema.maximum) fail(`须 <= ${schema.maximum}`);
}
