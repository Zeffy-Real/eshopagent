import type { Product } from '@/lib/types';

/** 图书（3 件）：用于验证跨品类搜索与对比 */
export const BOOK_PRODUCTS: Product[] = [
  {
    id: 'p-7001',
    name: '深入理解计算机系统（原书第 3 版）',
    brand: '机械工业出版社',
    category: '图书',
    price: 139,
    originalPrice: 239,
    rating: 4.9,
    reviews: 12800,
    sales: 32600,
    stock: 180,
    image: 'https://picsum.photos/seed/eshop-p-7001/640/480',
    description:
      '从程序员视角自底向上讲透计算机系统，覆盖数据表示、汇编、内存层次与并发；CSAPP 课程指定教材。',
    specifications: {
      作者: 'Randal E. Bryant / David R. O\'Hallaron',
      出版社: '机械工业出版社',
      页数: '737 页',
      装帧: '平装',
      ISBN: '9787111544937',
    },
    tags: ['计算机基础', '教材', '面试必备', '系统编程'],
  },
  {
    id: 'p-7002',
    name: '流畅的 Python（第 2 版）',
    brand: '人民邮电出版社',
    category: '图书',
    price: 129,
    originalPrice: 199,
    rating: 4.8,
    reviews: 6420,
    sales: 18400,
    stock: 96,
    image: 'https://picsum.photos/seed/eshop-p-7002/640/480',
    description:
      '深入讲解 Python 数据模型、迭代器、装饰器与并发；适合已会写 Python、想写出地道代码的开发者。',
    specifications: {
      作者: 'Luciano Ramalho',
      出版社: '人民邮电出版社',
      页数: '612 页',
      装帧: '平装',
      ISBN: '9787115546081',
    },
    tags: ['Python', '进阶', '最佳实践', '异步'],
  },
  {
    id: 'p-7003',
    name: '设计数据密集型应用',
    brand: '中国电力出版社',
    category: '图书',
    price: 118,
    originalPrice: 178,
    rating: 4.9,
    reviews: 5240,
    sales: 14200,
    stock: 14,
    image: 'https://picsum.photos/seed/eshop-p-7003/640/480',
    description:
      '系统梳理分布式系统的可靠性、可扩展性与可维护性；讲解复制、分区、事务与流处理的核心权衡。',
    specifications: {
      作者: 'Martin Kleppmann',
      出版社: '中国电力出版社',
      页数: '521 页',
      装帧: '平装',
      ISBN: '9787519821968',
    },
    tags: ['分布式', '系统设计', '架构', '面试必备'],
  },
];
