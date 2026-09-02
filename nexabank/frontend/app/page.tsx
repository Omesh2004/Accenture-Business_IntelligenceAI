"use client";

import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Lock,
  Shield,
  BarChart3,
  DollarSign,
  Star,
  Twitter,
  Linkedin,
  Facebook,
  Instagram,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import GlassCard from "@/components/ui/cards/GlassCard";
import { UserData } from "@/components/context/UserContext";
import { Skeleton } from "@/components/ui/skeleton";

export default function HomePage() {
  const { isAuth, isAuthLoading } = UserData();

  return (
    <div className="flex flex-col min-h-screen bg-white antialiased">
      {/* Hero Section */}
      <section className="relative min-h-screen flex flex-col justify-center bg-gradient-to-b from-white via-violet-50/50 to-white px-6 md:px-10 overflow-hidden">
        {/* Decorative elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-1/4 left-5 w-72 h-72 bg-violet-100 rounded-full filter blur-3xl opacity-50"></div>
          <div className="absolute bottom-1/4 right-5 w-96 h-96 bg-purple-100 rounded-full filter blur-3xl opacity-60"></div>
          <div className="absolute top-1/2 left-1/2 w-80 h-80 bg-blue-100 rounded-full filter blur-3xl opacity-40"></div>
        </div>

        {/* Content */}
        <div className="container mx-auto max-w-7xl py-20 relative z-10">
          <div className="flex flex-col md:flex-row items-center gap-12 md:gap-20">
            <div className="md:w-1/2 text-center md:text-left">
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold mb-6 animate-slide-up text-zinc-900 leading-tight tracking-tight">
                <span className="text-violet-600 font-extrabold">
                  Modern Banking
                </span>{" "}
                For a Modern World
              </h1>
              <p
                className="text-lg md:text-xl text-gray-600 mb-10 animate-slide-up max-w-xl md:mx-0 mx-auto"
                style={{ animationDelay: "150ms" }}
              >
                Experience seamless financial management with our award-winning
                banking platform. Secure, intuitive, and designed with your
                needs in mind.
              </p>
              <div
                className="flex flex-col sm:flex-row gap-4 animate-slide-up"
                style={{ animationDelay: "300ms" }}
              >
                {isAuthLoading ? (
                  <>
                    <Skeleton className="h-14 w-48 rounded-full bg-zinc-200" />
                    <Skeleton className="h-14 w-32 rounded-full bg-zinc-200" />
                  </>
                ) : isAuth ? (
                  <Button
                    size="lg"
                    asChild
                    className="bg-violet-600 hover:bg-violet-700 text-white rounded-full shadow-lg shadow-violet-200/50 hover:shadow-violet-300/50 transition-all cursor-pointer font-bold px-8 h-14"
                  >
                    <Link href="/dashboard" className="flex items-center">
                      Go to Dashboard
                      <ArrowRight className="ml-2 h-5 w-5" />
                    </Link>
                  </Button>
                ) : (
                  <>
                    <Button
                      size="lg"
                      asChild
                      className="bg-violet-600 hover:bg-violet-700 text-white rounded-full shadow-lg shadow-violet-200/50 hover:shadow-violet-300/50 transition-all cursor-pointer h-14"
                    >
                      <Link href="/register" className="flex items-center">
                        Get Started Now
                        <ArrowRight className="ml-2 h-5 w-5" />
                      </Link>
                    </Button>
                    <Button
                      size="lg"
                      variant="outline"
                      asChild
                      className="rounded-full border-violet-300 hover:bg-violet-50 hover:border-violet-400 transition-all cursor-pointer h-14"
                    >
                      <Link href="/login">Sign In</Link>
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* Hero image */}
            <div
              className="md:w-1/2 relative animate-fade-in"
              style={{ animationDelay: "450ms" }}
            >
              <div className="relative">
                {/* This would be a dashboard mockup image */}
                <div className="aspect-[9/16] md:aspect-[4/3] w-full max-w-lg rounded-2xl bg-gradient-to-br from-violet-600 to-purple-700 shadow-2xl relative overflow-hidden border-8 border-white md:ml-auto">
                  <div className="absolute inset-0 opacity-90 bg-[radial-gradient(at_top_right,_var(--tw-gradient-stops))] from-violet-900/20 via-violet-900/40 to-purple-900/60"></div>
                  <div className="absolute inset-0 flex flex-col p-8">
                    <div className="flex justify-between items-center mb-8">
                      <div className="text-white">
                        <p className="text-sm opacity-80">Current Balance</p>
                        <h3 className="text-2xl font-bold">₹8,256.42</h3>
                      </div>
                      <div className="h-10 w-10 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center">
                        <Shield className="h-5 w-5 text-white" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mb-6">
                      {[
                        { label: "Savings", value: "₹3,285.90" },
                        { label: "Checking", value: "₹4,970.52" },
                      ].map((account, i) => (
                        <div
                          key={i}
                          className="bg-white/10 backdrop-blur-sm p-4 rounded-xl"
                        >
                          <p className="text-white/70 text-xs">
                            {account.label}
                          </p>
                          <p className="text-white font-semibold">
                            {account.value}
                          </p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-auto">
                      <div className="text-white mb-2">
                        <p className="text-sm opacity-80">Recent Activity</p>
                      </div>
                      <div className="space-y-3">
                        {[
                          {
                            name: "Starbucks",
                            amount: "-₹450",
                            time: "9:32 AM",
                          },
                          {
                            name: "Amazon",
                            amount: "-₹299",
                            time: "Yesterday",
                          },
                          {
                            name: "Salary Deposit",
                            amount: "+₹2,850.00",
                            time: "Jun 1",
                          },
                        ].map((tx, i) => (
                          <div
                            key={i}
                            className="flex items-center justify-between p-2 bg-white/10 backdrop-blur-sm rounded-lg"
                          >
                            <div className="flex items-center">
                              <div className="h-8 w-8 rounded-full bg-white/20 mr-3"></div>
                              <div>
                                <p className="text-white text-sm font-medium">
                                  {tx.name}
                                </p>
                                <p className="text-white/70 text-xs">
                                  {tx.time}
                                </p>
                              </div>
                            </div>
                            <p
                              className={`font-medium ${tx.amount.startsWith("+")
                                  ? "text-green-300"
                                  : "text-white"
                                }`}
                            >
                              {tx.amount}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Decorative card elements */}
                {/* Card 1: Quick Action */}
                <div className="absolute -bottom-6 -left-6 w-48 h-32 bg-white dark:bg-gray-800 rounded-xl shadow-lg hidden md:block rotate-6 p-4 border border-violet-100 dark:border-violet-900/20">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 dark:text-violet-400">
                      <DollarSign className="h-4 w-4" />
                    </div>
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      Quick Transfer
                    </p>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Send to:
                    </span>
                    <span className="text-xs font-medium text-gray-800 dark:text-gray-200">
                      Aryan Raj
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between items-center">
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Amount:
                    </span>
                    <span className="text-xs font-medium text-violet-600 dark:text-violet-400">
                      ₹1200.00
                    </span>
                  </div>
                </div>

                {/* Card 2: Notification */}
                <div className="absolute -top-4 -right-8 w-48 h-28 bg-white dark:bg-gray-800 rounded-xl shadow-lg hidden md:block -rotate-12 p-4 border border-violet-100 dark:border-violet-900/20">
                  <div className="flex justify-between items-start mb-1">
                    <p className="text-xs font-medium text-gray-800 dark:text-gray-200">
                      Security Alert
                    </p>
                    <div className="w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center text-red-600 dark:text-red-400">
                      <span className="text-xs">!</span>
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Login attempt detected from a new device.
                  </p>
                  <div className="flex justify-end">
                    <span className="text-xs text-violet-600 dark:text-violet-400 font-medium">
                      Verify Now
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-24 px-6 md:px-10 bg-white relative">
        {/* Decorative background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-20 right-0 w-64 h-64 bg-violet-50 rounded-full filter blur-3xl opacity-70"></div>
          <div className="absolute top-40 -left-20 w-72 h-72 bg-blue-50 rounded-full filter blur-3xl opacity-70"></div>
        </div>

        <div className="container mx-auto max-w-6xl relative z-10">
          <div className="flex flex-col items-center text-center mb-16">
            <div className="inline-block mb-3 px-4 py-1 bg-violet-100 text-violet-700 rounded-full font-medium text-sm">
              Why Choose NexaBank?
            </div>
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-zinc-900">
              Banking that works for you
            </h2>
            <p className="text-lg text-gray-700 max-w-2xl mx-auto">
              Our modern banking platform offers everything you need to manage
              your finances efficiently in one secure place.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-6">
            {[
              {
                icon: <Shield className="h-7 w-7 text-violet-600" />,
                title: "Secure Banking",
                description:
                  "Bank with confidence knowing your data is protected with industry-leading security protocols.",
              },
              {
                icon: <CreditCard className="h-7 w-7 text-violet-600" />,
                title: "Easy Payments",
                description:
                  "Send money, pay bills, and manage transactions with just a few taps from anywhere.",
              },
              {
                icon: <BarChart3 className="h-7 w-7 text-violet-600" />,
                title: "Financial Insights",
                description:
                  "Get detailed analytics and personalized insights to make smarter financial decisions.",
              },
              {
                icon: <Lock className="h-7 w-7 text-violet-600" />,
                title: "Privacy First",
                description:
                  "Your privacy matters. We never sell your data or share it with third parties.",
              },
            ].map((feature, index) => (
              <GlassCard
                key={index}
                delay={index * 100}
                className="p-8 flex flex-col items-center text-center h-full rounded-2xl transition-all duration-300 hover:shadow-xl hover:-translate-y-1 border border-gray-100 bg-white/80 backdrop-blur-sm"
              >
                <div className="mb-5 p-4 rounded-xl bg-violet-100">
                  {feature.icon}
                </div>
                <h3 className="text-xl font-semibold mb-3 text-zinc-900">
                  {feature.title}
                </h3>
                <p className="text-gray-600">{feature.description}</p>
              </GlassCard>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="py-24 px-6 md:px-10 bg-gradient-to-b from-violet-50/50 to-white">
        <div className="container mx-auto max-w-6xl">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="inline-block mb-3 px-4 py-1 bg-violet-100 text-violet-700 rounded-full font-medium text-sm">
                Experience The Difference
              </div>
              <h2 className="text-3xl md:text-4xl font-bold mb-6 text-zinc-900 leading-tight">
                Banking reimagined for the digital age
              </h2>
              <p className="text-lg text-gray-700 mb-8">
                NexaBank combines cutting-edge technology with thoughtful
                design to provide you with a banking experience that's both
                powerful and intuitive.
              </p>

              <ul className="space-y-5">
                {[
                  "24/7 access to your accounts from any device",
                  "Real-time notifications for all transactions",
                  "Instant transfers between accounts with zero fees",
                  "Smart budgeting tools that adapt to your lifestyle",
                  "Award-winning customer support available anytime",
                ].map((benefit, index) => (
                  <li key={index} className="flex items-start">
                    <div className="bg-violet-100 rounded-full p-1 mr-3 flex-shrink-0 mt-0.5">
                      <CheckCircle2 className="h-5 w-5 text-violet-600" />
                    </div>
                    <span className="text-gray-700">{benefit}</span>
                  </li>
                ))}
              </ul>

              <Button
                asChild
                className="mt-10 bg-violet-600 hover:bg-violet-700 text-white rounded-full shadow-md hover:shadow-lg transition-all"
              >
                <Link href="/register" className="flex items-center">
                  Open an Account <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>

            {/* App interface mockup */}
            <div className="relative">
              <div className="relative rounded-2xl overflow-hidden shadow-2xl border-8 border-white transform transition-transform hover:rotate-1 duration-500">
                <img
                  src="/interface.png"
                  alt="Banking App Interface"
                  className="w-full h-auto"
                />

                {/* If no image is available yet, use this placeholder */}
                {/* <div className="aspect-[4/3] bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                  <div className="text-white text-center p-6">
                    <Shield className="h-12 w-12 text-white/80 mx-auto mb-4" />
                    <h3 className="text-xl font-bold mb-2">NexaBank Dashboard</h3>
                    <p className="text-white/80">Banking app interface mockup will appear here</p>
                  </div>
                </div> */}
              </div>

              {/* Floating elements around the mockup */}
              <div className="absolute top-1/4 -left-4 bg-white rounded-xl shadow-lg p-3 transform -rotate-3 hidden md:block">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600">
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Payment Complete</p>
                    <p className="font-medium text-sm">₹2500</p>
                  </div>
                </div>
              </div>

              <div className="absolute bottom-1/4 -right-4 bg-white rounded-xl shadow-lg p-3 transform rotate-3 hidden md:block">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center text-violet-600">
                    <Star className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">Interest Added</p>
                    <p className="font-medium text-sm">+₹124.20</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer - Enhanced Version */}
      <footer className="bg-gradient-to-b from-gray-900 to-gray-950 text-white py-20 px-6 md:px-10 relative overflow-hidden">
        {/* Background decoration */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute bottom-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-violet-500 to-transparent"></div>
          <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-violet-500 via-transparent to-violet-500 opacity-30"></div>
          <div className="absolute -top-48 -right-48 w-96 h-96 bg-violet-900/20 rounded-full filter blur-3xl"></div>
          <div className="absolute -bottom-48 -left-48 w-96 h-96 bg-purple-900/20 rounded-full filter blur-3xl"></div>
        </div>

        <div className="container mx-auto max-w-6xl relative z-10">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-12 mb-16">
            {/* Brand Column */}
            <div className="md:col-span-4 space-y-6">
              <div className="flex items-center">
                <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-violet-600 to-purple-600 flex items-center justify-center shadow-lg">
                  <Shield className="h-6 w-6 text-white" />
                </div>
                <div className="ml-3">
                  <span className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-violet-400 to-purple-300">
                    NexaBank
                  </span>
                </div>
              </div>

              <p className="text-gray-400 pr-4">
                Secure, simple banking for a complex world. Manage your finances
                with confidence using our award-winning digital platform.
              </p>
            </div>

            {/* Links Section */}
            <div className="md:col-span-8">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
                {[
                  {
                    title: "Company",
                    links: ["About Us", "Careers", "Press", "Blog"],
                  },
                  {
                    title: "Products",
                    links: ["Checking", "Savings", "Credit Cards", "Loans"],
                  },
                  {
                    title: "Resources",
                    links: ["Help Center", "FAQs", "Security", "Contact Us"],
                  },
                  {
                    title: "Legal",
                    links: [
                      "Privacy Policy",
                      "Terms of Service",
                      "Cookie Policy",
                      "Licenses",
                    ],
                  },
                ].map((column, i) => (
                  <div key={i}>
                    <h3 className="text-lg font-semibold mb-4">
                      <span className="bg-clip-text text-transparent bg-gradient-to-r from-violet-400 to-purple-300">
                        {column.title}
                      </span>
                    </h3>
                    <ul className="space-y-3">
                      {column.links.map((link, j) => (
                        <li key={j}>
                          <Link
                            href="#"
                            className="text-gray-400 hover:text-white transition-colors text-sm flex items-center group"
                          >
                            <span className="inline-block w-0 group-hover:w-2 h-[1px] bg-violet-400 mr-0 group-hover:mr-2 transition-all duration-300"></span>
                            {link}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Social + Newsletter Section */}
          <div className="border-t border-gray-800/70 pt-10 pb-8 flex flex-col md:flex-row gap-8 justify-between items-center">
            <div className="flex gap-6">
              {[
                { name: "Twitter", icon: <Twitter className="h-5 w-5" /> },
                { name: "LinkedIn", icon: <Linkedin className="h-5 w-5" /> },
                { name: "Facebook", icon: <Facebook className="h-5 w-5" /> },
                { name: "Instagram", icon: <Instagram className="h-5 w-5" /> },
              ].map((platform, i) => (
                <Link
                  key={i}
                  href="#"
                  className="w-10 h-10 rounded-full bg-white/5 hover:bg-violet-600/30 border border-white/10 flex items-center justify-center transition-colors group"
                  aria-label={platform.name}
                >
                  <span className="sr-only">{platform.name}</span>
                  <div className="text-gray-400 group-hover:text-violet-300 transition-colors">
                    {platform.icon}
                  </div>
                </Link>
              ))}
            </div>

            <div className="flex items-center">
              <form className="flex items-center">
                <div className="relative">
                  <input
                    type="email"
                    placeholder="Your email address"
                    className="bg-white/5 border border-white/10 rounded-l-full py-2 pl-4 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-transparent w-56"
                  />
                </div>
                <button
                  type="submit"
                  className="bg-violet-600 hover:bg-violet-700 transition-colors text-white rounded-r-full py-2 px-4 text-sm font-medium border border-violet-600"
                >
                  Subscribe
                </button>
              </form>
            </div>
          </div>

          {/* Bottom Bar */}
          <div className="border-t border-gray-800/50 mt-6 pt-8 flex flex-col md:flex-row justify-between items-center text-gray-500 text-sm">
            <p>© 2025 NexaBank. All rights reserved.</p>

            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-4 md:mt-0 justify-center">
              <Link
                href="#"
                className="hover:text-violet-400 transition-colors"
              >
                Accessibility
              </Link>
              <Link
                href="#"
                className="hover:text-violet-400 transition-colors"
              >
                Responsible Banking
              </Link>
              <Link
                href="#"
                className="hover:text-violet-400 transition-colors"
              >
                Sitemap
              </Link>
              <div className="flex items-center">
                <span className="inline-flex items-center px-2 py-1 bg-gradient-to-r from-violet-900/30 to-purple-900/30 rounded-full text-xs font-medium text-violet-400 mr-2">
                  Banking System Status
                </span>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
