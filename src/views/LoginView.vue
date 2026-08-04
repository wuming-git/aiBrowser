<template>
  <div class="auth">
    <div class="auth-left">
      <div class="mark">browser168</div>
      <h1 class="headline">指纹浏览器<br />重新定义工作流</h1>
      <p class="lede">独立环境、智能代理、定时编排。为专业团队打造。</p>
    </div>

    <div class="auth-right">
      <div class="form-wrap">
        <h2 class="form-title">登录</h2>
        <p class="form-desc">使用邮箱进入工作台</p>

        <el-form label-position="top" @submit.prevent="onSubmit">
          <el-form-item label="邮箱">
            <el-input
              v-model="email"
              type="email"
              size="large"
              placeholder="name@company.com"
            />
          </el-form-item>
          <el-form-item label="密码">
            <el-input
              v-model="password"
              type="password"
              size="large"
              show-password
              placeholder="至少 6 位"
            />
          </el-form-item>
          <el-button
            type="primary"
            size="large"
            class="submit"
            :loading="loading"
            @click="onSubmit"
          >
            继续
          </el-button>
        </el-form>

        <p class="foot">
          还没有账号？
          <router-link to="/register">注册</router-link>
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { authApi } from '@/api'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const email = ref('')
const password = ref('')
const loading = ref(false)

async function onSubmit() {
  if (!email.value || !password.value) {
    ElMessage.warning('请填写邮箱和密码')
    return
  }
  loading.value = true
  try {
    const res = await authApi.login({ email: email.value, password: password.value })
    auth.setSession(res.data.token, res.data.email)
    ElMessage.success('登录成功')
    router.push('/profiles')
  } catch (e: any) {
    ElMessage.error(e.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.auth {
  min-height: 100dvh;
  display: grid;
  grid-template-columns: 1.05fr 0.95fr;
  background: var(--yt-bg);
  animation: yt-in 0.6s var(--yt-ease) both;
  position: relative;
}

.auth::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(ellipse 60% 50% at 18% 78%, rgba(237, 243, 236, 0.9), transparent 70%),
    radial-gradient(ellipse 40% 35% at 88% 12%, rgba(251, 243, 219, 0.55), transparent 65%);
  opacity: 0.85;
}

.auth-left,
.auth-right {
  position: relative;
  z-index: 1;
}

.auth-left {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 56px 64px 72px;
  border-right: 1px solid var(--yt-border);
}

.mark {
  margin-bottom: auto;
  padding-top: 8px;
  font-family: var(--yt-font);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--yt-text);
}

.headline {
  margin: 0 0 22px;
  font-family: var(--yt-font);
  font-size: clamp(34px, 4.2vw, 48px);
  font-weight: 650;
  letter-spacing: -0.035em;
  line-height: 1.15;
  color: var(--yt-text);
}

.lede {
  margin: 0;
  max-width: 28ch;
  font-size: 15px;
  line-height: 1.65;
  color: var(--yt-muted);
}

.auth-right {
  display: grid;
  place-items: center;
  padding: 40px 24px;
  background: var(--yt-bg);
}

.form-wrap {
  width: min(360px, 100%);
}

.form-title {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.03em;
}

.form-desc {
  margin: 0 0 28px;
  font-size: 14px;
  color: var(--yt-muted);
}

.submit {
  width: 100%;
  margin-top: 8px;
  height: 44px;
  font-size: 15px;
}

.foot {
  margin: 28px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--yt-muted);
}

@media (max-width: 860px) {
  .auth {
    grid-template-columns: 1fr;
  }
  .auth-left {
    border-right: none;
    border-bottom: 1px solid var(--yt-border);
    padding: 32px 28px 36px;
    justify-content: flex-start;
    min-height: auto;
  }
  .mark {
    margin-bottom: 36px;
  }
  .headline {
    font-size: 34px;
  }
}
</style>
