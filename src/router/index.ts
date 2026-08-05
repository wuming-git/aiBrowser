import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LayoutView from '@/views/LayoutView.vue'
import ProfileListView from '@/views/ProfileListView.vue'
import ScheduleJobsView from '@/views/ScheduleJobsView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', component: () => import('@/views/LoginView.vue') },
    { path: '/register', component: () => import('@/views/RegisterView.vue') },
    {
      path: '/',
      component: LayoutView,
      meta: { auth: true },
      children: [
        { path: '', redirect: '/profiles' },
        { path: 'profiles', component: ProfileListView },
        { path: 'profiles/new', component: () => import('@/views/ProfileEditView.vue') },
        { path: 'profiles/:id', component: () => import('@/views/ProfileEditView.vue') },
        { path: 'schedules', component: ScheduleJobsView },
        { path: 'skills', component: () => import('@/views/SkillsView.vue') },
        { path: 'tools', component: () => import('@/views/ToolsView.vue') },
        { path: 'agent', redirect: '/profiles' }
      ]
    }
  ]
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  if (to.meta.auth && !auth.token) return '/login'
  if ((to.path === '/login' || to.path === '/register') && auth.token) return '/profiles'
})

export default router
