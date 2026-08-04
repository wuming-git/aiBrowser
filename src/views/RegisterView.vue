<template>
  <div class="auth">
    <div class="auth-left">
      <div class="mark">browser168</div>
      <h1 class="headline">创建账号</h1>
      <p class="lede">邮箱注册即可使用完整工作台能力。</p>
    </div>

    <div class="auth-right">
      <div class="form-wrap">
        <h2 class="form-title">注册</h2>
        <p class="form-desc">填写邮箱与密码即可开始</p>

        <el-form label-position="top" @submit.prevent="onSubmit">
          <el-form-item label="邮箱">
            <el-input v-model="email" type="email" size="large" placeholder="name@company.com" />
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
            注册并登录
          </el-button>
        </el-form>

        <p class="foot">
          已有账号？
          <router-link to="/login">登录</router-link>
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
  if (password.value.length < 6) {
    ElMessage.warning('密码至少 6 位')
    return
  }
  loading.value = true
  try {
    const res = await authApi.register({
      email: email.value,
      password: password.value
    })
    auth.setSession(res.data.token, res.data.email)
    ElMessage.success('注册成功')
    router.push('/profiles')
  } catch (e: any) {
    ElMessage.error(e.message || '注册失败')
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
}

.auth-left {
  padding: 48px 56px;
  border-right: 1px solid var(--yt-border);
  display: flex;
  flex-direction: column;
  justify-content: center;
  background:
    radial-gradient(ellipse 70% 50% at 20% 80%, rgba(225, 243, 254, 0.35), transparent 70%),
    radial-gradient(ellipse 55% 40% at 80% 20%, rgba(237, 243, 236, 0.45), transparent 65%);
}

.mark {
  font-family: var(--yt-font);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--yt-text);
  margin-bottom: 56px;
}

.headline {
  margin: 0 0 16px;
  font-family: var(--yt-font);
  font-size: clamp(36px, 5vw, 52px);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.08;
  color: var(--yt-text);
}

.lede {
  margin: 0;
  max-width: 28ch;
  font-size: 16px;
  font-weight: 500;
  line-height: 1.55;
  color: var(--yt-muted);
}

.auth-right {
  display: grid;
  place-items: center;
  padding: 40px 28px;
}

.form-wrap {
  width: min(380px, 100%);
}

.form-title {
  margin: 0 0 6px;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--yt-text);
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
  }
  .mark {
    margin-bottom: 36px;
  }
}
</style>
