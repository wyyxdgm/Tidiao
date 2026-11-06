"use client";

// 表单字段版本的 Select: 把客户端组件 (Select) 包成可直接放进 server <form action>
// 的字段, 内部用同名 hidden input 把选中值写到 FormData, server action 通过
// formData.get(name) 拿到值. 用于修复 R64: 「select 等组件复用系统组件」
// —— 直接把原生的 <select name=...> 换成 <SelectField name=... options=... /> 即可.
//
// 用法:
//   <form action={serverAction}>
//     <SelectField name="project_id" options={projects.map(p => ({value: p.id, label: p.name}))} />
//     <SelectField name="priority" options={[{value:"1",label:"P1"},...]} />
//   </form>
//
// 关注点:
//   - 受控 vs 非受控: 这里用非受控 (defaultValue), 跟原生 <select> 行为一致, 让 server
//     action 决定提交什么值; 客户端只渲染 + 收集.
//   - required 处理: HTML <form required> 会校验 hidden input, hidden input 总有值
//     (空字符串也行), 因此这里 required 校验要交给 server action (createRequirement
//     已做 !project_id 检查), 不要依赖浏览器原生 required.

import { useState, useEffect } from "react";
import Select, { type SelectOption } from "./Select";

interface SelectFieldProps {
  name: string;
  options: SelectOption[];
  defaultValue?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
}

export default function SelectField({
  name,
  options,
  defaultValue = "",
  placeholder,
  required,
  className,
}: SelectFieldProps) {
  const [value, setValue] = useState(defaultValue);

  // 同步 value 到 hidden input —— formData.get(name) 读的就是这个.
  // 用 useEffect + ref 写入避免 hydration mismatch (SSR 时还没 onChange).
  useEffect(() => {
    const el = document.querySelector<HTMLInputElement>(`input[type=hidden][data-select-field="${name}"]`);
    if (el) el.value = value;
  }, [value, name]);

  return (
    <div className={className}>
      <Select
        value={value}
        onChange={setValue}
        options={options}
        placeholder={placeholder}
      />
      <input
        type="hidden"
        name={name}
        data-select-field={name}
        defaultValue={defaultValue}
        required={required}
      />
    </div>
  );
}