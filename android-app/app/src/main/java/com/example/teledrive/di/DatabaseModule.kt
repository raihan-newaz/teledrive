package com.example.teledrive.di

import android.content.Context
import androidx.room.Room
import com.example.teledrive.data.local.FileDao
import com.example.teledrive.data.local.FolderDao
import com.example.teledrive.data.local.ShareDao
import com.example.teledrive.data.local.TeleDriveDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): TeleDriveDatabase {
        return Room.databaseBuilder(
            context,
            TeleDriveDatabase::class.java,
            "teledrive.db"
        )
            .fallbackToDestructiveMigration()
            .build()
    }

    @Provides
    fun provideFileDao(database: TeleDriveDatabase): FileDao = database.fileDao()

    @Provides
    fun provideFolderDao(database: TeleDriveDatabase): FolderDao = database.folderDao()

    @Provides
    fun provideShareDao(database: TeleDriveDatabase): ShareDao = database.shareDao()
}
