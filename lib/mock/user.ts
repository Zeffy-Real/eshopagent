import type { Coupon, OrderAddress } from '@/lib/types';

/** 模拟登录用户 */
export const MOCK_USER = {
  id: 'u-10086',
  name: '泽飞',
  avatarText: '泽',
} as const;

/** 模拟收货地址（下单确认弹窗使用，不做真实地址管理） */
export const MOCK_ADDRESS: OrderAddress = {
  name: '泽飞',
  phone: '138****6688',
  province: '广东省',
  city: '深圳市',
  district: '南山区',
  detail: '科技园南区 8 栋 1203 室',
};

/** 模拟优惠券（自动选取满足门槛且抵扣最多的一张） */
export const COUPONS: Coupon[] = [
  {
    code: 'SAVE30',
    title: '满 300 减 30',
    threshold: 300,
    amount: 30,
    description: '全场通用，单笔订单可用一张',
  },
  {
    code: 'SAVE100',
    title: '满 1000 减 100',
    threshold: 1000,
    amount: 100,
    description: '全场通用，不与满 300 减 30 叠加',
  },
  {
    code: 'SAVE300',
    title: '满 3000 减 300',
    threshold: 3000,
    amount: 300,
    description: '全场通用，大额订单专用',
  },
];
