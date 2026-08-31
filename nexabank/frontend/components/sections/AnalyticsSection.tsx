'use client';
import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { CreditCard, TrendingUp, TrendingDown, Activity } from 'lucide-react';

interface AnalyticsProps {
  accounts: any[];
  transactions: any[];
}

const COLORS = ['#6366F1', '#8B5CF6', '#EC4899', '#14B8A6', '#F59E0B', '#F43F5E'];

const AnalyticsSection: React.FC<AnalyticsProps> = ({ accounts = [], transactions = [] }) => {
  // Derive values safely
  const { totalBalance, income, expenses, monthlyData, categoryData } = useMemo(() => {
    const userAccountNumbers = new Set(accounts.map((acc) => acc.accNo));

    // Total Balance
    const balance = accounts.reduce((sum, acc) => sum + (acc.balance || 0), 0);

    let inc = 0;
    let exp = 0;
    const categoryMap: Record<string, number> = {};
    const monthMap: Record<string, number> = {};

    transactions.forEach((tx) => {
      const amount = tx.amount || 0;
      const isSending = userAccountNumbers.has(tx.senderAccount);
      const isReceiving = userAccountNumbers.has(tx.receiverAccount);

      // Determine Income vs Expense
      if (tx.transactionType === 'DEPOSIT' || isReceiving && !isSending) {
        inc += amount;
      } else if (tx.transactionType === 'WITHDRAWAL' || tx.transactionType === 'PAYMENT' || isSending) {
        exp += amount;
        
        // Categorize expenses
        const cat = tx.category || 'OTHERS';
        categoryMap[cat] = (categoryMap[cat] || 0) + amount;
      }

      // Group by month
      const date = new Date(tx.updatedOn || tx.createdOn || Date.now());
      const month = date.toLocaleString('default', { month: 'short' });
      monthMap[month] = (monthMap[month] || 0) + 1; // Count or Amount? Let's chart Amount.
      // Or actually let's just do count of transactions per month based on the mock data which used amount:
      monthMap[month] = (monthMap[month] || 0) + amount;
    });

    const catData = Object.keys(categoryMap).map((key, i) => ({
      name: key,
      value: categoryMap[key],
      color: COLORS[i % COLORS.length]
    }));

    // Generate last 6 months list safely in order
    const monthsOrder = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      monthsOrder.push(d.toLocaleString('default', { month: 'short' }));
    }

    const mData = monthsOrder.map((m) => ({
      month: m,
      amount: monthMap[m] || 0
    }));

    return {
      totalBalance: balance,
      income: inc,
      expenses: exp,
      monthlyData: mData,
      categoryData: catData.length > 0 ? catData : [{ name: 'No Data', value: 1, color: '#E5E7EB' }]
    };
  }, [accounts, transactions]);

  const summaryCards = [
    { title: 'Total Balance', value: `₹${totalBalance.toLocaleString('en-IN')}`, icon: <CreditCard className="h-5 w-5" />, color: 'bg-violet-100 text-violet-600' },
    { title: 'Income', value: `₹${income.toLocaleString('en-IN')}`, icon: <TrendingUp className="h-5 w-5" />, color: 'bg-emerald-100 text-emerald-600' },
    { title: 'Expenses', value: `₹${expenses.toLocaleString('en-IN')}`, icon: <TrendingDown className="h-5 w-5" />, color: 'bg-rose-100 text-rose-600' },
    { title: 'Transactions', value: transactions.length.toLocaleString('en-IN'), icon: <Activity className="h-5 w-5" />, color: 'bg-purple-100 text-purple-600' },
  ];

  return (
    <div className="w-full">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {summaryCards.map((card, index) => (
          <div key={index} className="flex flex-col items-center p-5 bg-white border border-violet-100 rounded-xl shadow-sm hover:shadow-md transition-all cursor-default">
            <div className={`rounded-full p-3 mb-3 ${card.color}`}>
              {card.icon}
            </div>
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">{card.title}</p>
              <p className="text-xl font-bold text-zinc-900">{card.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly Transactions Bar Chart */}
        <div className="p-5 border border-violet-100 rounded-xl bg-white shadow-sm">
          <h2 className="text-lg font-bold text-zinc-900 mb-6 font-sans">Monthly Volume (₹)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={monthlyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#6B7280' }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#6B7280' }} tickFormatter={(val) => `₹${val>=1000 ? (val/1000)+'k' : val}`} />
              <Tooltip cursor={{ fill: '#F3F4F6' }} formatter={(val: number) => `₹${val.toLocaleString('en-IN')}`} />
              <Bar dataKey="amount" fill="#7C3AED" radius={[4, 4, 0, 0]} barSize={32} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Category Breakdown Pie Chart */}
        <div className="p-5 border border-violet-100 rounded-xl bg-white shadow-sm flex flex-col">
          <h2 className="text-lg font-bold text-zinc-900 mb-2 font-sans">Expense Distribution</h2>
          <div className="flex-grow flex items-center justify-center">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={categoryData}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={5}
                >
                  {categoryData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(val: number) => `₹${val.toLocaleString('en-IN')}`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalyticsSection;