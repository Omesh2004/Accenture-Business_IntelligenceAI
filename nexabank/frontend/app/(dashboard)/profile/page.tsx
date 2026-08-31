"use client"

import type React from "react"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Edit, Mail, Phone, Save, User } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { UserData } from "@/components/context/UserContext"
import { useRouter } from "next/navigation"
import axios from "axios"
import { API_BASE_URL } from "@/lib/api"
import { toast } from "sonner"
import { Skeleton } from "@/components/ui/skeleton"
import Image from "next/image"
import { useEventTracker } from "@/hooks/useEventTracker"


export default function ProfilePage() {

   const { track, measureAndTrack } = useEventTracker();
   const { userId ,isAuth, isAuthLoading } = UserData();

  
   const router = useRouter()
    const [loading, setLoading] = useState(true);
    useEffect(() => {
      if (!isAuth) {
        if (!isAuthLoading) router.push("/login");
      }
    }, [isAuth, isAuthLoading, router]);

  // Track profile page view
  useEffect(() => {
    if (isAuth && !isAuthLoading) {
      track('profile.page.view');
    }
  }, [isAuth, isAuthLoading, track]);

  useEffect(() => {
      console.log("profile id:",userId);
    }, [userId]);


  const [isEditing, setIsEditing] = useState(false)
  const [profileData, setProfileData] = useState({
    name: "",
    email: "",
    phone: "",
    street: "",
    city: "",
    state: "",
    zipCode: "",
    country: "India",
    pan: "",
    role: "",
    createdAt: "",
  })

  useEffect(() => {
    if (isAuth) {
      fetchProfile();
    }
  }, [isAuth]);

  const fetchProfile = useCallback(async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/auth/profile`, { withCredentials: true });
      const data = res.data;
      const addr = data.address || {};
      setProfileData({
        name: data.name || "",
        email: data.email || "",
        phone: data.phone || "",
        street: addr.street || "",
        city: addr.city || "",
        state: addr.state || "",
        zipCode: addr.zipCode || addr.zipcode || addr.pinCode || addr.postalCode || "",
        country: addr.country || "India",
        pan: data.pan || "",
        role: data.role || "USER",
        createdAt: data.createdAt || "",
      });
    } catch (err) {
      console.error("Failed to fetch profile:", err);
      toast.error("Failed to load profile data");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target
    setProfileData((prev) => ({
      ...prev,
      [name]: value,
    }))
  }, [])

  const handleSaveProfile = useCallback(async () => {
    try {
      await measureAndTrack('profile.edit_details', async () => {
        await axios.put(`${API_BASE_URL}/auth/updateUser`, {
          id: userId,
          name: profileData.name,
          email: profileData.email,
          phone: profileData.phone,
          pan: profileData.pan,
          address: {
            street: profileData.street,
            city: profileData.city,
            state: profileData.state,
            zipCode: profileData.zipCode,
            country: profileData.country
          }
        }, { withCredentials: true });
      });
      
      toast.success("Profile updated successfully!");
      setIsEditing(false);
      fetchProfile();
    } catch (err: any) {
      console.error("Update failed:", err);
      toast.error(err.response?.data?.error || "Failed to update profile");
    }
  }, [userId, profileData, fetchProfile, measureAndTrack])


  if (loading || isAuthLoading || !isAuth) {
    return (
      <div className="flex flex-col gap-6 animate-pulse">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <Skeleton className="h-10 w-48 mb-2 bg-zinc-200" />
            <Skeleton className="h-5 w-72 bg-zinc-200/50" />
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-12 w-96 bg-zinc-200 rounded-lg" />
          <Skeleton className="h-[400px] w-full bg-zinc-100 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
          <p className="text-muted-foreground">Manage your account settings and preferences.</p>
        </div>
      </div>

          <Card className="">
            <CardHeader className="flex flex-row items-center  justify-between space-y-0">
              <div>
                <CardTitle>Personal Information</CardTitle>
                <CardDescription>Manage your personal details and contact information.</CardDescription>
              </div>
              <Button variant="outline" size="icon" onClick={() => setIsEditing(!isEditing)}>
                {isEditing ? <Save className="h-4 w-4" /> : <Edit className="h-4 w-4" />}
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-col md:flex-row gap-6 items-center">
                  <Avatar className="h-24 w-24 border-4 border-white shadow-lg bg-violet-100 text-violet-700 font-bold text-3xl">
                    <AvatarImage src="/user.png" alt="Profile" />
                    <AvatarFallback>{profileData.name?.charAt(0) || "U"}</AvatarFallback>
                  </Avatar>
                <div className="space-y-1 text-center md:text-left">
                  <h3 className="text-2xl font-bold">
                    {profileData.name || "User"}
                  </h3>
                  <p className="text-muted-foreground">Premium Account</p>
                  <p className="text-sm text-muted-foreground">Member since March 2023</p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="name">Full Name</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="name"
                      name="name"
                      value={profileData.name}
                      onChange={handleInputChange}
                      className="pl-10"
                      disabled={!isEditing}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="email"
                      name="email"
                      type="email"
                      value={profileData.email}
                      onChange={handleInputChange}
                      className="pl-10"
                      disabled={!isEditing}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="phone"
                      name="phone"
                      value={profileData.phone}
                      onChange={handleInputChange}
                      className="pl-10"
                      disabled={!isEditing}
                    />
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="street">Street Address</Label>
                  <Input
                    id="street"
                    name="street"
                    value={profileData.street}
                    onChange={handleInputChange}
                    disabled={!isEditing}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="city">City</Label>
                  <Input
                    id="city"
                    name="city"
                    value={profileData.city}
                    onChange={handleInputChange}
                    disabled={!isEditing}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="state">State</Label>
                  <Input
                    id="state"
                    name="state"
                    value={profileData.state}
                    onChange={handleInputChange}
                    disabled={!isEditing}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="zipCode">Zip Code</Label>
                  <Input
                    id="zipCode"
                    name="zipCode"
                    value={profileData.zipCode}
                    onChange={handleInputChange}
                    placeholder="e.g., 100001"
                    disabled={!isEditing}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="country">Country</Label>
                  <Input
                    id="country"
                    name="country"
                    value={profileData.country}
                    onChange={handleInputChange}
                    placeholder="e.g., India"
                    disabled={!isEditing}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="pan">PAN Number</Label>
                  <Input
                    id="pan"
                    name="pan"
                    value={profileData.pan}
                    onChange={handleInputChange}
                    disabled={!isEditing}
                    className="uppercase font-mono"
                  />
                </div>
              </div>
            </CardContent>
            <CardFooter className="flex justify-end">
              {isEditing && (
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setIsEditing(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSaveProfile}>Save Changes</Button>
                </div>
              )}
            </CardFooter>
          </Card>
    </div>
  )
}

