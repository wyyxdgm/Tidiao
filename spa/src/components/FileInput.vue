<script setup lang="ts">
/* 功能: 文件选择 — 封装原生 <input type="file">. 默认隐藏 (纯触发器), 通过
   expose open() 让父组件调用 .click() 打开文件选择对话框; @change 上抛 FileList.

   关注点:
   - 默认 hidden (display:none); 父组件自己渲染触发器 (拖拽区 / 📎 按钮 / 上传区块),
     点击触发器时调用 fileInputRef.open() (见下). 与原生的 ref.click() 模式 1:1 对应,
     只是把 <input> 藏到组件内.
   - multiple / accept 透传原生属性.
   - capture 不暴露 —— 文件选择通常不需要强制摄像头/麦克风, 留给调用方直接用原生
     <input> (极少见, 不值得为它加 prop).
   - v-model 不暴露: 文件选择是 "snapshot" 操作 (选完一次性消费), 不是连续值;
     父组件通过 @change 拿到 FileList 自行处理. 与 R8 Input.vue (字符串连续值) 区分.
   - reset(): 清空已选 (value='') — 让父组件能复用同一组件多次打开; 不自动调用,
     父组件 @change 后自己决定要不要 reset.
   - 与原生 input 同款 disabled: true 时不响应 open(). */
import { ref } from 'vue';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  /** 是否允许多选. */
  multiple?: boolean;
  /** 接受的文件类型. 原生 accept 属性, e.g. 'image/*' / '.pdf,.doc'. */
  accept?: string;
  /** 禁用. true 时 open() 无效. */
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  multiple: false,
  accept: undefined,
  disabled: false,
});

const emit = defineEmits<{
  /** 文件选择变化 (用户选了文件 / 取消选择). 父组件决定怎么处理 FileList. */
  (e: 'change', files: FileList | null): void;
}>();

/* ------------------------------------------------------------------ */
/*  Refs                                                               */
/* ------------------------------------------------------------------ */

const inputRef = ref<HTMLInputElement | null>(null);

/* ------------------------------------------------------------------ */
/*  Exposed methods                                                    */
/* ------------------------------------------------------------------ */

/** 触发文件选择对话框 (等价于原生 input.click()). */
function open(): void {
  if (props.disabled) return;
  inputRef.value?.click();
}

/** 清空已选文件. 让父组件能复用同一组件再次打开 (否则浏览器会记住上次选择). */
function reset(): void {
  if (inputRef.value) inputRef.value.value = '';
}

defineExpose({ open, reset });

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function onChange(e: Event): void {
  const target = e.target as HTMLInputElement;
  emit('change', target.files);
}
</script>

<template>
  <input
    ref="inputRef"
    type="file"
    :multiple="multiple"
    :accept="accept"
    :disabled="disabled"
    class="file-input-hidden"
    @change="onChange"
  />
</template>

<style scoped>
/* 隐藏原生 input — 调用方自己渲染可视化触发器.
   不能 display:none 否则部分浏览器 .click() 失效, 用 visibility:hidden + 0 尺寸
   保留触发能力. */
.file-input-hidden {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}
</style>